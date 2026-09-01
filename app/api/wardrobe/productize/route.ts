import { requireSession, responseForAuthError } from "../../../lib/auth";
import { encodeGarmentTags, normalizeGarmentAITags, type GarmentAITags } from "../../../lib/garment-tags";
import {
  configuredGarmentCutoutMode,
  segmentGarmentToWhiteBackground,
  type GarmentAtlasClass,
  type GarmentCutoutProvider,
  type GarmentSegmentationApi,
} from "../../../lib/aliyun-segmentation";
import { apiErrorResponse, logServerEvent } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";

type CachedProduct = {
  quality: "good" | "review";
  contentType: "image/jpeg";
  provider: GarmentCutoutProvider;
  geometry: "atlas" | "source" | "square-1024";
  foregroundRatio: number;
  atlasClasses?: GarmentAtlasClass[];
  atlasForegroundRatios?: number[];
  atlasForegroundBounds?: Array<[number, number, number, number]>;
  sourceWidth?: number;
  sourceHeight?: number;
};

const productCache = new Map<string, { bytes: Buffer; meta: CachedProduct }>();
const maxCachedProducts = 50;
const maxCachedProductBytes = 32 * 1024 * 1024;
let cachedProductBytes = 0;

async function productCacheKey(
  buffer: ArrayBuffer,
  category: string,
  color: string,
  api: string,
  geometry: string,
) {
  const prefix = new TextEncoder().encode(`layra-segment-v7\n${api}\n${geometry}\n${category}\n${color}\n`);
  const bytes = new Uint8Array(prefix.length + buffer.byteLength);
  bytes.set(prefix);
  bytes.set(new Uint8Array(buffer), prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function productResponse(
  bytes: Uint8Array<ArrayBufferLike> | ArrayBuffer,
  meta: CachedProduct,
  tags: GarmentAITags,
  quality: "good" | "review",
  cacheStatus: "HIT" | "MISS",
  elapsedMs: number,
) {
  const body = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
  return new Response(body, {
    headers: {
      "Content-Type": meta.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Yida-Quality": quality,
      "X-Yida-Output": "product-image-white-background",
      // Tags describe the current detection, not the cached image bytes.
      "X-Yida-Tags": encodeGarmentTags(tags),
      "X-Yida-Cache": cacheStatus,
      "X-Yida-Geometry": meta.geometry,
      "X-Yida-Foreground-Ratio": meta.foregroundRatio.toFixed(5),
      ...(meta.atlasClasses?.length ? { "X-Yida-Atlas-Classes": meta.atlasClasses.join(",") } : {}),
      ...(meta.atlasForegroundRatios?.length
        ? { "X-Yida-Atlas-Foreground-Ratios": meta.atlasForegroundRatios.map(value => value.toFixed(5)).join(",") }
        : {}),
      ...(meta.atlasForegroundBounds?.length
        ? { "X-Yida-Atlas-Foreground-Bounds": meta.atlasForegroundBounds.map(bounds => bounds.join(",")).join(";") }
        : {}),
      ...(meta.sourceWidth ? { "X-Yida-Source-Width": String(meta.sourceWidth) } : {}),
      ...(meta.sourceHeight ? { "X-Yida-Source-Height": String(meta.sourceHeight) } : {}),
      "X-Layra-Provider": meta.provider,
      "X-Layra-Latency-Ms": String(elapsedMs),
      "Server-Timing": `segmentation;dur=${elapsedMs}`,
    },
  });
}

function readAtlasClasses(value: FormDataEntryValue | null, api: GarmentSegmentationApi) {
  if (api !== "SegmentCloth") return undefined;
  const allowed = new Set<GarmentAtlasClass>(["tops", "pants"]);
  const classes = String(value || "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter((value): value is GarmentAtlasClass => allowed.has(value as GarmentAtlasClass));
  return classes.length ? Array.from(new Set(classes)) : undefined;
}

function storeCachedProduct(cacheBase: string, bytes: Buffer, meta: CachedProduct) {
  const existing = productCache.get(cacheBase);
  if (existing) cachedProductBytes -= existing.bytes.byteLength;
  productCache.delete(cacheBase);
  productCache.set(cacheBase, { bytes, meta });
  cachedProductBytes += bytes.byteLength;
  while (productCache.size > maxCachedProducts || cachedProductBytes > maxCachedProductBytes) {
    const oldestKey = productCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = productCache.get(oldestKey);
    productCache.delete(oldestKey);
    if (oldest) cachedProductBytes -= oldest.bytes.byteLength;
  }
}

function readTags(value: FormDataEntryValue | null, category: string, color: string) {
  try {
    return normalizeGarmentAITags(JSON.parse(String(value || "{}")), { category, color });
  } catch {
    return normalizeGarmentAITags(null, { category, color });
  }
}

async function handlePOST(request: Request) {
  const startedAt = performance.now();
  try {
    requireSession(request);
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      return Response.json({ error: "请上传需要抠图的单品照片" }, { status: 400 });
    }
    // Alibaba image-segmentation uploads are capped below the generic upload
    // limit. Rejecting here avoids spending the entire request budget upstream.
    if (image.size > 3 * 1024 * 1024) {
      return Response.json({ error: "抠图图片不能超过 3MB" }, { status: 400 });
    }

    const category = String(form.get("category") || "服饰").trim().slice(0, 20);
    const color = String(form.get("color") || "").trim().slice(0, 20);
    const api: GarmentSegmentationApi = form.get("recommendedApi") === "SegmentCommodity" ? "SegmentCommodity" : "SegmentCloth";
    const preserveGeometry = form.get("preserveGeometry") === "true" && api === "SegmentCloth";
    const atlasClasses = readAtlasClasses(form.get("atlasClasses"), api);
    const combinedAtlas = form.get("combinedAtlas") === "true" && (atlasClasses?.length || 0) > 1;
    const geometryKey = atlasClasses?.length ? `atlas:${atlasClasses.join(",")}` : preserveGeometry ? "source" : "square-1024";
    const partiallyOccluded = form.get("partiallyOccluded") === "true";
    const requestedDeadlineMs = Number(form.get("deadlineMs"));
    const deadlineMs = Number.isFinite(requestedDeadlineMs)
      ? Math.max(1_000, Math.min(10_000, Math.round(requestedDeadlineMs)))
      : 9_000;
    const tags = readTags(form.get("tags"), category, color);
    const sourceBuffer = await image.arrayBuffer();
    const cutoutMode = configuredGarmentCutoutMode();
    const cacheHash = await productCacheKey(sourceBuffer, category, color, api, `${geometryKey}:${cutoutMode}`);
    const cacheBase = `product-cache/segment-v7/${cacheHash}`;
    const cached = productCache.get(cacheBase);
    if (cached) {
      productCache.delete(cacheBase);
      productCache.set(cacheBase, cached);
      return productResponse(
        cached.bytes,
        cached.meta,
        tags,
        partiallyOccluded ? "review" : cached.meta.quality,
        "HIT",
        Math.round(performance.now() - startedAt),
      );
    }

    const segmented = await segmentGarmentToWhiteBackground(sourceBuffer, api, {
      preserveGeometry,
      atlasClasses,
      combinedAtlas,
      deadlineAt: Date.now() + deadlineMs,
    });
    const meta: CachedProduct = {
      quality: segmented.quality,
      contentType: segmented.contentType,
      provider: segmented.provider,
      geometry: segmented.geometry,
      foregroundRatio: segmented.foregroundRatio,
      atlasClasses: segmented.atlasClasses,
      atlasForegroundRatios: segmented.atlasForegroundRatios,
      atlasForegroundBounds: segmented.atlasForegroundBounds,
      sourceWidth: segmented.sourceWidth,
      sourceHeight: segmented.sourceHeight,
    };
    storeCachedProduct(cacheBase, segmented.bytes, meta);
    const totalMs = Math.round(performance.now() - startedAt);
    logServerEvent("info", "wardrobe_segmentation_completed", {
      api,
      provider: segmented.provider,
      geometry: segmented.geometry,
      vendor_ms: segmented.elapsedMs,
      total_ms: totalMs,
      cache: "MISS",
    });
    return productResponse(
      segmented.bytes,
      meta,
      tags,
      partiallyOccluded ? "review" : meta.quality,
      "MISS",
      totalMs,
    );
  } catch (error) {
    const authResponse = responseForAuthError(error);
    if (authResponse) return authResponse;
    return apiErrorResponse(request, error, "高清白底商品图生成失败");
  }
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "高清白底商品图生成失败");
}
