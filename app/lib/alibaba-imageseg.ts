import { getServerEnv, requireServerEnv } from "./server-env";

type RpcPayload = Record<string, unknown> & {
  Code?: string;
  Message?: string;
  RequestId?: string;
  Data?: Record<string, unknown>;
};

function percentEncode(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function bytesToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function hmacSha1(secret: string, content: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  return bytesToBase64(await crypto.subtle.sign("HMAC", key, encoder.encode(content)));
}

export async function callImageSeg(action: "SegmentCloth" | "SegmentCommodity" | "RefineMask", input: Record<string, string>) {
  const accessKeyId = requireServerEnv("ALIBABA_CLOUD_ACCESS_KEY_ID");
  const accessKeySecret = requireServerEnv("ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  const regionId = getServerEnv("ALIBABA_CLOUD_REGION_ID") || "cn-shanghai";
  const parameters: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: action,
    Format: "JSON",
    RegionId: regionId,
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2019-12-30",
    ...input,
  };
  const canonicalQuery = Object.entries(parameters)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalQuery)}`;
  parameters.Signature = await hmacSha1(`${accessKeySecret}&`, stringToSign);

  const response = await fetch(`https://imageseg.${regionId}.aliyuncs.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json() as RpcPayload;
  if (!response.ok || payload.Code) {
    throw new Error(payload.Message || payload.Code || `图像处理失败（${response.status}）`);
  }
  return payload;
}

export function getImageSegResultUrl(payload: RpcPayload) {
  const data = payload.Data;
  if (!data) return "";
  if (typeof data.ImageURL === "string") return data.ImageURL;
  const elements = Array.isArray(data.Elements) ? data.Elements as Array<Record<string, unknown>> : [];
  return typeof elements[0]?.ImageURL === "string" ? elements[0].ImageURL : "";
}

async function getOssStsToken(accessKeyId: string, accessKeySecret: string) {
  const parameters: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: "GetOssStsToken",
    Format: "JSON",
    RegionId: "cn-shanghai",
    SignatureMethod: "HMAC-SHA1",
    SignatureNonce: crypto.randomUUID(),
    SignatureVersion: "1.0",
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Version: "2020-04-01",
  };
  const canonicalQuery = Object.entries(parameters)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
    .join("&");
  const stringToSign = `POST&${percentEncode("/")}&${percentEncode(canonicalQuery)}`;
  parameters.Signature = await hmacSha1(`${accessKeySecret}&`, stringToSign);

  const response = await fetch("https://viapiutils.cn-shanghai.aliyuncs.com/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json() as { Data?: { AccessKeyId?: string; AccessKeySecret?: string; SecurityToken?: string } };
  if (!response.ok || !payload.Data?.AccessKeyId || !payload.Data?.AccessKeySecret || !payload.Data?.SecurityToken) {
    throw new Error("获取临时上传凭证失败");
  }
  return { accessKeyId: payload.Data.AccessKeyId, accessKeySecret: payload.Data.AccessKeySecret, securityToken: payload.Data.SecurityToken };
}

/**
 * 将本地图片上传到阿里云视觉智能官方临时 OSS，返回公网 URL，
 * 供 SegmentCloth / SegmentCommodity 等抠图接口使用（本地开发也能用，无需内网穿透）。
 * 注意：该临时存储仅供调试，生产环境建议改用自建 OSS/TOS。
 */
export async function uploadImageToViapi(buffer: Uint8Array, contentType: string, extension: string): Promise<string> {
  const accessKeyId = requireServerEnv("ALIBABA_CLOUD_ACCESS_KEY_ID");
  const accessKeySecret = requireServerEnv("ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  const sts = await getOssStsToken(accessKeyId, accessKeySecret);
  const objectName = `${accessKeyId}/${crypto.randomUUID()}.${extension}`;
  const date = new Date().toUTCString();
  const stringToSign = `PUT\n\n${contentType}\n${date}\nx-oss-security-token:${sts.securityToken}\n/viapi-customer-temp/${objectName}`;
  const signature = await hmacSha1(sts.accessKeySecret, stringToSign);
  const response = await fetch(`https://viapi-customer-temp.oss-cn-shanghai.aliyuncs.com/${objectName}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "Date": date,
      "x-oss-security-token": sts.securityToken,
      "Authorization": `OSS ${sts.accessKeyId}:${signature}`,
    },
    body: Buffer.from(buffer) as unknown as BodyInit,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("图片上传失败");
  return `http://viapi-customer-temp.oss-cn-shanghai.aliyuncs.com/${objectName}`;
}
