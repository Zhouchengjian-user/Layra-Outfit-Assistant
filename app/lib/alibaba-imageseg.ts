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
