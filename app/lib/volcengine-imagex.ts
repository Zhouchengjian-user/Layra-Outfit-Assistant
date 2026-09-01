import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";
import sharp from "sharp";
import { getServerEnv } from "./server-env";
import { getStorageRequestContext } from "./storage-request-context";
import { storageCreateSignedGetUrl, storageDelete, storagePut } from "./storage";

type VolcCredentials = {
  accessKeyId: string;
  secretKey: string;
  sessionToken?: string;
};

type ImageXResponse = {
  ResponseMetadata?: {
    RequestId?: string;
    Error?: { Code?: string; Message?: string };
  };
  Result?: Record<string, unknown>;
};

export type VolcengineImageXCutout = {
  rgba: Buffer;
  providerMs: number;
  resultUri: string;
};

const IMAGEX_API_VERSION = "2018-08-01";
const IMAGEX_SERVICE = "imagex";
const DEFAULT_IMAGEX_HOST = "imagex.volcengineapi.com";
const DEFAULT_IMAGEX_REGION = "cn-north-1";

function configuredCredentials(): VolcCredentials | null {
  const dedicatedAccessKeyId = getServerEnv("VOLC_ACCESSKEY") || getServerEnv("VOLCENGINE_ACCESS_KEY_ID");
  const dedicatedSecretKey = getServerEnv("VOLC_SECRETKEY") || getServerEnv("VOLCENGINE_SECRET_ACCESS_KEY");
  const dedicatedSessionToken = getServerEnv("VOLC_SESSION_TOKEN") || getServerEnv("VOLCENGINE_SESSION_TOKEN");
  if (dedicatedAccessKeyId && dedicatedSecretKey) {
    return {
      accessKeyId: dedicatedAccessKeyId,
      secretKey: dedicatedSecretKey,
      ...(dedicatedSessionToken ? { sessionToken: dedicatedSessionToken } : {}),
    };
  }

  const requestCredentials = getStorageRequestContext();
  if (requestCredentials) {
    return {
      accessKeyId: requestCredentials.accessKeyId,
      secretKey: requestCredentials.secretAccessKey,
      sessionToken: requestCredentials.sessionToken,
    };
  }

  const accessKeyId = getServerEnv("TOS_ACCESS_KEY_ID");
  const secretKey = getServerEnv("TOS_ACCESS_KEY_SECRET");
  const sessionToken = getServerEnv("TOS_SESSION_TOKEN");
  if (!accessKeyId || !secretKey) return null;
  return { accessKeyId, secretKey, ...(sessionToken ? { sessionToken } : {}) };
}

export function isVolcengineImageXConfigured() {
  return Boolean(
    getServerEnv("TOS_BUCKET")
    && getServerEnv("VOLC_IMAGEX_SERVICE_ID")
    && getServerEnv("VOLC_IMAGEX_DOMAIN")
    && configuredCredentials(),
  );
}

function uriEscape(value: string) {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(parameters: Record<string, string>) {
  return Object.entries(parameters)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${uriEscape(key)}=${uriEscape(String(value))}`)
    .join("&");
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string) {
  return createHmac("sha256", key).update(value).digest();
}

function dateTime(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signedHeaders(
  method: "GET" | "POST",
  query: Record<string, string>,
  body: string,
  credentials: VolcCredentials,
) {
  const region = getServerEnv("VOLC_IMAGEX_REGION") || DEFAULT_IMAGEX_REGION;
  const timestamp = dateTime();
  const shortDate = timestamp.slice(0, 8);
  const headers: Record<string, string> = { "X-Date": timestamp };
  if (body) headers["X-Content-Sha256"] = sha256(body);
  if (credentials.sessionToken) headers["X-Security-Token"] = credentials.sessionToken;

  // Match Volcengine's official V4 signer: content-type is deliberately not a
  // signed header, while every X-* authentication header is included.
  const canonicalHeaderEntries = Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const canonicalHeaderBlock = canonicalHeaderEntries.map(([key, value]) => `${key}:${value}`).join("\n");
  const signedHeaderNames = canonicalHeaderEntries.map(([key]) => key).join(";");
  const bodyHash = body ? headers["X-Content-Sha256"] : sha256("");
  const canonicalRequest = [
    method,
    "/",
    canonicalQuery(query),
    `${canonicalHeaderBlock}\n`,
    signedHeaderNames,
    bodyHash,
  ].join("\n");
  const credentialScope = `${shortDate}/${region}/${IMAGEX_SERVICE}/request`;
  const stringToSign = ["HMAC-SHA256", timestamp, credentialScope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(credentials.secretKey, shortDate);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, IMAGEX_SERVICE);
  const signingKey = hmac(serviceKey, "request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.Authorization = `HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
  return headers;
}

function imageXError(payload: ImageXResponse, fallback: string) {
  const error = payload.ResponseMetadata?.Error;
  const detail = error?.Message || error?.Code;
  return new Error(detail ? `${fallback}：${detail}` : fallback);
}

async function callImageX(
  method: "GET" | "POST",
  action: string,
  parameters: Record<string, string>,
  bodyValue: Record<string, unknown> | null,
  deadlineAt: number,
) {
  const credentials = configuredCredentials();
  if (!credentials) throw new Error("火山引擎 ImageX 访问密钥未配置");
  const host = getServerEnv("VOLC_IMAGEX_HOST") || DEFAULT_IMAGEX_HOST;
  const body = bodyValue ? JSON.stringify(bodyValue) : "";
  const query = { ...parameters, Action: action, Version: IMAGEX_API_VERSION };
  const headers = signedHeaders(method, query, body, credentials);
  if (body) headers["Content-Type"] = "application/json; charset=utf-8";
  const remaining = deadlineAt - Date.now();
  if (remaining <= 250) throw new Error("火山引擎商品抠图已超时");
  const response = await fetch(`https://${host}/?${canonicalQuery(query)}`, {
    method,
    headers,
    ...(body ? { body } : {}),
    signal: AbortSignal.timeout(Math.min(8_000, remaining)),
  });
  const payload = await response.json().catch(() => ({})) as ImageXResponse;
  if (!response.ok || payload.ResponseMetadata?.Error) {
    throw imageXError(payload, `ImageX ${action} 调用失败`);
  }
  return payload.Result || {};
}

function stringField(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

async function resultUrl(resultUri: string, deadlineAt: number) {
  if (/^https?:\/\//i.test(resultUri)) return resultUri;
  const serviceId = getServerEnv("VOLC_IMAGEX_SERVICE_ID");
  const domain = getServerEnv("VOLC_IMAGEX_DOMAIN").replace(/^https?:\/\//i, "").replace(/\/$/, "");
  // The default public acceleration domain only issues temporary URLs through
  // a template. Every ImageX service gets this lossless "获取原图" template at
  // creation time; custom deployments may override it explicitly.
  const template = getServerEnv("VOLC_IMAGEX_TEMPLATE") || `tplv-${serviceId}-image`;
  const result = await callImageX("GET", "GetResourceURL", {
    ServiceId: serviceId,
    Domain: domain,
    URI: resultUri,
    Tpl: template,
    Proto: "https",
    Format: "image",
    Timestamp: "300",
  }, null, deadlineAt);
  const url = stringField(result, "ObjURL", "obj_url", "URL", "url");
  if (!url) throw new Error("ImageX 未返回抠图结果地址");
  return url;
}

async function downloadResult(url: string, deadlineAt: number) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 250) throw new Error("火山引擎抠图结果下载超时");
  const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(4_000, remaining)) });
  if (!response.ok) throw new Error("火山引擎抠图结果下载失败");
  return Buffer.from(await response.arrayBuffer());
}

/**
 * 使用 veImageX productv2 对已经按单品裁剪的图片做像素级抠图。
 *
 * productv2 不负责从全身照拆出多件衣物；多件检测仍由上游 VLM + bbox
 * 完成，本函数只处理单个裁剪结果，避免把人体或其他衣物并入商品图。
 */
export async function runVolcengineImageXProductCutout(
  source: Buffer,
  deadlineAt: number,
): Promise<VolcengineImageXCutout> {
  if (!isVolcengineImageXConfigured()) {
    throw new Error("尚未完整配置火山引擎 ImageX 商品抠图");
  }
  const startedAt = performance.now();
  const serviceId = getServerEnv("VOLC_IMAGEX_SERVICE_ID");
  const temporaryKey = `imagex-inputs/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.jpg`;
  try {
    const normalized = await sharp(source, { failOn: "none", limitInputPixels: 80_000_000 })
      .rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
      .toBuffer();
    await storagePut(temporaryKey, normalized, "image/jpeg");
    const inputUrl = await storageCreateSignedGetUrl(temporaryKey, 300);
    if (!inputUrl) throw new Error("ImageX 需要可访问的 TOS 临时地址");

    const result = await callImageX("POST", "GetSegmentImage", { ServiceId: serviceId }, {
      Class: "productv2",
      Refine: true,
      TransBg: true,
      OutFormat: "png",
      StoreUri: inputUrl,
    }, deadlineAt);
    const resultUri = stringField(result, "ResUri", "res_uri", "Uri", "uri");
    if (!resultUri) throw new Error("ImageX productv2 未返回结果 URI");
    const url = await resultUrl(resultUri, deadlineAt);
    const rgba = await downloadResult(url, deadlineAt);
    return {
      rgba,
      resultUri,
      providerMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    // 临时输入不是用户衣柜资产，无论上游成功或失败都立即清理。
    await storageDelete(temporaryKey).catch(() => undefined);
  }
}
