import "server-only";

import { Readable } from "node:stream";
import ImagesegClient, {
  SegmentClothAdvanceRequest,
  SegmentCommodityAdvanceRequest,
} from "@alicloud/imageseg20191230";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@alicloud/tea-util";
import sharp from "sharp";
import { comfyUiAvailable, isComfyUiConfigured, runComfyUiBiRefNetCutout } from "./comfyui-cutout";
import { getServerEnv } from "./server-env";
import { requireServerEnv } from "./server-env";

export type GarmentSegmentationApi = "SegmentCloth" | "SegmentCommodity";
export type GarmentAtlasClass = "tops" | "pants";
export type GarmentCutoutProvider = "aliyun-viapi" | "comfyui-birefnet";
export type GarmentCutoutMode = "aliyun" | "comfyui" | "hybrid";

export type SegmentationResult = {
  bytes: Buffer;
  contentType: "image/jpeg";
  elapsedMs: number;
  provider: GarmentCutoutProvider;
  geometry: "atlas" | "source" | "square-1024";
  quality: "good" | "review";
  foregroundRatio: number;
  atlasClasses?: GarmentAtlasClass[];
  atlasForegroundRatios?: number[];
  atlasForegroundBounds?: Array<[number, number, number, number]>;
  sourceWidth?: number;
  sourceHeight?: number;
};

type SegmentationOptions = {
  preserveGeometry?: boolean;
  atlasClasses?: GarmentAtlasClass[];
  combinedAtlas?: boolean;
  deadlineAt?: number;
};

type ProviderJob = {
  deadlineAt: number;
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
  run: () => Promise<unknown>;
};

const maxProviderConcurrency = 6;
const providerStartsPerSecond = 2;
// VIAPI advertises 2 QPS but rejects short bursts in practice. Space starts so
// a five-photo batch stays below the account-wide throttle instead of firing
// two calls in the same instant.
const minimumProviderStartSpacingMs = 525;
const providerQueue: ProviderJob[] = [];
const providerStartTimes: number[] = [];
let providerRunning = 0;
let providerPumpTimer: ReturnType<typeof setTimeout> | null = null;
let client: ImagesegClient | null = null;

function imagesegClient() {
  if (client) return client;
  client = new ImagesegClient(new $OpenApiUtil.Config({
    accessKeyId: requireServerEnv("ALIBABA_CLOUD_ACCESS_KEY_ID"),
    accessKeySecret: requireServerEnv("ALIBABA_CLOUD_ACCESS_KEY_SECRET"),
    endpoint: "imageseg.cn-shanghai.aliyuncs.com",
    regionId: "cn-shanghai",
    connectTimeout: 3_000,
    readTimeout: 8_000,
  }));
  return client;
}

function runtimeOptions(deadlineAt: number) {
  const remaining = Math.max(500, deadlineAt - Date.now());
  return new RuntimeOptions({
    autoretry: false,
    maxAttempts: 1,
    connectTimeout: Math.min(3_000, remaining),
    readTimeout: Math.min(8_000, remaining),
  });
}

function scheduleProviderPump(delay = 0) {
  if (providerPumpTimer) clearTimeout(providerPumpTimer);
  providerPumpTimer = setTimeout(() => {
    providerPumpTimer = null;
    pumpProviderQueue();
  }, Math.max(0, delay));
}

function pumpProviderQueue() {
  const now = Date.now();
  while (providerStartTimes.length && providerStartTimes[0] <= now - 1_000) providerStartTimes.shift();

  for (let index = providerQueue.length - 1; index >= 0; index -= 1) {
    if (providerQueue[index].deadlineAt > now) continue;
    const [expired] = providerQueue.splice(index, 1);
    expired.reject(new Error("抠图请求排队超时"));
  }

  while (
    providerQueue.length
    && providerRunning < maxProviderConcurrency
    && providerStartTimes.length < providerStartsPerSecond
  ) {
    const latestStart = providerStartTimes.at(-1);
    if (latestStart && latestStart > Date.now() - minimumProviderStartSpacingMs) break;
    const job = providerQueue.shift()!;
    providerRunning += 1;
    providerStartTimes.push(Date.now());
    void job.run().then(job.resolve, job.reject).finally(() => {
      providerRunning -= 1;
      pumpProviderQueue();
    });
  }

  if (!providerQueue.length) return;
  const nextRateSlot = providerStartTimes.length >= providerStartsPerSecond
    ? Math.max(1, providerStartTimes[0] + 1_000 - Date.now())
    : Number.POSITIVE_INFINITY;
  const latestStart = providerStartTimes.at(-1);
  const nextSpacingSlot = latestStart
    ? Math.max(1, latestStart + minimumProviderStartSpacingMs - Date.now())
    : Number.POSITIVE_INFINITY;
  const nextDeadline = Math.max(1, Math.min(...providerQueue.map(job => job.deadlineAt)) - Date.now());
  scheduleProviderPump(Math.min(nextRateSlot, nextSpacingSlot, nextDeadline));
}

function withProviderStartLimit<T>(run: () => Promise<T>, deadlineAt: number) {
  return new Promise<T>((resolve, reject) => {
    if (deadlineAt <= Date.now()) {
      reject(new Error("抠图请求已超过处理时限"));
      return;
    }
    providerQueue.push({
      deadlineAt,
      run,
      resolve: value => resolve(value as T),
      reject,
    });
    pumpProviderQueue();
  });
}

async function fetchResultBuffer(url: string, deadlineAt: number) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 250) throw new Error("抠图结果下载超时");
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Math.min(3_500, remaining)),
  });
  if (!response.ok) throw new Error("抠图结果下载失败");
  return Buffer.from(await response.arrayBuffer());
}

async function segmentResultUrl(source: Buffer, api: GarmentSegmentationApi, deadlineAt: number) {
  const stream = Readable.from(source);
  if (api === "SegmentCommodity") {
    const response = await imagesegClient().segmentCommodityAdvance(
      new SegmentCommodityAdvanceRequest({ imageURLObject: stream, returnForm: "whiteBK" }),
      runtimeOptions(deadlineAt),
    );
    return response.body?.data?.imageURL || "";
  }
  const response = await imagesegClient().segmentClothAdvance(
    new SegmentClothAdvanceRequest({ imageURLObject: stream, returnForm: "whiteBK" }),
    runtimeOptions(deadlineAt),
  );
  return response.body?.data?.elements?.[0]?.imageURL || "";
}

async function segmentAtlasUrl(
  source: Buffer,
  atlasClass: GarmentAtlasClass,
  deadlineAt: number,
) {
  const response = await imagesegClient().segmentClothAdvance(
    new SegmentClothAdvanceRequest({
      imageURLObject: Readable.from(source),
      outMode: 1,
      clothClass: [atlasClass],
      returnForm: "mask",
    }),
    runtimeOptions(deadlineAt),
  );
  const elements = response.body?.data?.elements || [];
  // Merge every element because ClassUrl can appear after the combined image.
  const classUrls = Object.assign({}, ...elements.map(element => element?.classUrl || {})) as Record<string, string>;
  return classResultUrl(classUrls, atlasClass)
    || elements.find(element => element?.imageURL)?.imageURL
    || "";
}

async function segmentCombinedAtlasUrls(
  source: Buffer,
  atlasClasses: GarmentAtlasClass[],
  deadlineAt: number,
) {
  const response = await imagesegClient().segmentClothAdvance(
    new SegmentClothAdvanceRequest({
      imageURLObject: Readable.from(source),
      outMode: 1,
      clothClass: atlasClasses,
      returnForm: "mask",
    }),
    runtimeOptions(deadlineAt),
  );
  const elements = response.body?.data?.elements || [];
  const classUrls = Object.assign({}, ...elements.map(element => element?.classUrl || {})) as Record<string, string>;
  if (!atlasClasses.every(atlasClass => classResultUrl(classUrls, atlasClass))) {
    throw new Error("分类抠图未返回完整面板");
  }
  return classUrls;
}

function classResultUrl(classUrls: Record<string, string>, target: GarmentAtlasClass) {
  const exact = classUrls[target];
  if (exact) return exact;
  const normalized = Object.entries(classUrls).find(([key]) => key.trim().toLowerCase() === target);
  return normalized?.[1] || "";
}

async function normalizedMask(mask: Buffer, width: number, height: number) {
  const { data } = await sharp(mask)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sampledTotal = 0;
  let sampledCount = 0;
  const stride = Math.max(1, Math.floor(data.length / 16_384));
  for (let offset = 0; offset < data.length; offset += stride) {
    sampledTotal += data[offset];
    sampledCount += 1;
  }
  // ClassUrl is normally white-foreground/black-background. Some revisions of
  // the service returned the inverse, so choose the minority side as foreground.
  const invert = sampledCount > 0 && sampledTotal / sampledCount > 127;
  let foreground = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < data.length; offset += 1) {
    const value = invert ? 255 - data[offset] : data[offset];
    data[offset] = value;
    if (value > 20) {
      const x = offset % width;
      const y = Math.floor(offset / width);
      foreground += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const bounds: [number, number, number, number] = maxX >= minX && maxY >= minY
    ? [minX, minY, maxX - minX + 1, maxY - minY + 1]
    : [0, 0, 0, 0];
  return { data, foregroundRatio: foreground / Math.max(1, data.length), bounds };
}

async function createAtlas(
  source: Buffer,
  classUrls: Record<string, string>,
  atlasClasses: GarmentAtlasClass[],
  deadlineAt: number,
) {
  const orientedSource = await sharp(source)
    .rotate()
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
    .toBuffer({ resolveWithObject: true });
  const width = orientedSource.info.width;
  const height = orientedSource.info.height;
  if (!width || !height) throw new Error("无法读取原图尺寸");

  const downloaded = await Promise.all(atlasClasses.map(async atlasClass => {
    const url = classResultUrl(classUrls, atlasClass);
    if (!url) return null;
    try {
      return await fetchResultBuffer(url, deadlineAt);
    } catch {
      return null;
    }
  }));
  if (downloaded.every(value => value === null)) throw new Error("分类抠图未返回可识别地址");
  const sourcePixels = await sharp(orientedSource.data).removeAlpha().raw().toBuffer();

  const panelResults = await Promise.all(downloaded.map(async maskBuffer => {
    if (!maskBuffer) return { mask: null, ratio: 0, bounds: [0, 0, 0, 0] as [number, number, number, number] };
    const mask = await normalizedMask(maskBuffer, width, height);
    return {
      mask: mask.foregroundRatio >= 0.0005 ? mask.data : null,
      ratio: mask.foregroundRatio,
      bounds: mask.bounds,
    };
  }));

  // Build the RGB sprite directly. The previous pipeline encoded two temporary
  // PNG panels per photo and decoded them again for compositing, which made a
  // five-photo upload CPU-bound even after the provider had finished.
  const atlasWidth = width * atlasClasses.length;
  const atlasPixels = Buffer.alloc(atlasWidth * height * 3, 255);
  for (const [panelIndex, result] of panelResults.entries()) {
    if (!result.mask) continue;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const alpha = result.mask[pixel];
      if (alpha === 0) continue;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const sourceOffset = pixel * 3;
      const targetOffset = (y * atlasWidth + panelIndex * width + x) * 3;
      const inverse = 255 - alpha;
      atlasPixels[targetOffset] = Math.round((sourcePixels[sourceOffset] * alpha + 255 * inverse) / 255);
      atlasPixels[targetOffset + 1] = Math.round((sourcePixels[sourceOffset + 1] * alpha + 255 * inverse) / 255);
      atlasPixels[targetOffset + 2] = Math.round((sourcePixels[sourceOffset + 2] * alpha + 255 * inverse) / 255);
    }
  }

  const bytes = await sharp(atlasPixels, { raw: { width: atlasWidth, height, channels: 3 } })
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return {
    bytes,
    ratios: panelResults.map(result => result.ratio),
    bounds: panelResults.map(result => result.bounds),
    width,
    height,
  };
}

async function whiteForegroundRatio(bytes: Buffer) {
  const { data, info } = await sharp(bytes)
    .rotate()
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  let foreground = 0;
  let samples = 0;
  const pixelStride = Math.max(1, Math.floor(info.width * info.height / 100_000));
  for (let pixel = 0; pixel < info.width * info.height; pixel += pixelStride) {
    const offset = pixel * channels;
    if (765 - data[offset] - data[offset + 1] - data[offset + 2] > 15) foreground += 1;
    samples += 1;
  }
  return foreground / Math.max(1, samples);
}

async function alphaForegroundRatio(bytes: Buffer) {
  const { data, info } = await sharp(bytes, { failOn: "none", limitInputPixels: 80_000_000 })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let foreground = 0;
  let samples = 0;
  const pixelStride = Math.max(1, Math.floor(info.width * info.height / 100_000));
  for (let pixel = 0; pixel < info.width * info.height; pixel += pixelStride) {
    if (data[pixel * info.channels + 3] > 20) foreground += 1;
    samples += 1;
  }
  return foreground / Math.max(1, samples);
}

export function configuredGarmentCutoutMode(): GarmentCutoutMode {
  const value = getServerEnv("CUTOUT_PROVIDER").toLowerCase();
  if (value === "comfyui" || value === "hybrid") return value;
  return "aliyun";
}

async function segmentWithComfyUi(
  sourceBuffer: Buffer,
  options: SegmentationOptions,
  deadlineAt: number,
): Promise<SegmentationResult> {
  const result = await runComfyUiBiRefNetCutout(sourceBuffer, "image/jpeg", deadlineAt);
  const foregroundRatio = await alphaForegroundRatio(result.rgba);
  const pipeline = sharp(result.rgba, { failOn: "none", limitInputPixels: 80_000_000 }).rotate();
  const bytes = options.preserveGeometry
    ? await pipeline
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer()
    : await pipeline
      .resize(1024, 1024, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();
  return {
    bytes,
    contentType: "image/jpeg",
    elapsedMs: result.providerMs,
    provider: "comfyui-birefnet",
    geometry: options.preserveGeometry ? "source" : "square-1024",
    quality: foregroundRatio >= 0.008 && foregroundRatio <= 0.92 ? "good" : "review",
    foregroundRatio,
  };
}

export async function segmentGarmentToWhiteBackground(
  source: ArrayBuffer,
  api: GarmentSegmentationApi,
  options: SegmentationOptions = {},
): Promise<SegmentationResult> {
  const startedAt = performance.now();
  const sourceBuffer = Buffer.from(source);
  const deadlineAt = Math.min(options.deadlineAt || Date.now() + 9_000, Date.now() + 12_000);
  const atlasClasses = api === "SegmentCloth" ? options.atlasClasses?.slice(0, 4) : undefined;
  const cutoutMode = configuredGarmentCutoutMode();

  if (atlasClasses?.length) {
    const preferComfyForIndividualItems = cutoutMode !== "aliyun"
      && isComfyUiConfigured()
      && await comfyUiAvailable(Math.min(1_200, deadlineAt - Date.now()));
    if (cutoutMode === "comfyui" || preferComfyForIndividualItems) {
      throw new Error("ComfyUI BiRefNet 不支持上衣/下装分类面板，请等待单件识别后再抠图");
    }
    const classUrls = options.combinedAtlas
      ? await withProviderStartLimit(
        () => segmentCombinedAtlasUrls(sourceBuffer, atlasClasses, deadlineAt),
        deadlineAt,
      )
      : Object.fromEntries(await Promise.all(atlasClasses.map(async atlasClass => [
        atlasClass,
        await withProviderStartLimit(
          () => segmentAtlasUrl(sourceBuffer, atlasClass, deadlineAt),
          deadlineAt,
        ),
      ] as const)));
    const atlas = await createAtlas(sourceBuffer, classUrls, atlasClasses, deadlineAt);
    return {
      bytes: atlas.bytes,
      contentType: "image/jpeg",
      elapsedMs: Math.round(performance.now() - startedAt),
      provider: "aliyun-viapi",
      geometry: "atlas",
      // A successful atlas is not sufficient evidence that an individual item
      // is clean. The browser validates each requested panel crop separately.
      quality: "review",
      foregroundRatio: Math.max(0, ...atlas.ratios),
      atlasClasses,
      atlasForegroundRatios: atlas.ratios,
      atlasForegroundBounds: atlas.bounds,
      sourceWidth: atlas.width,
      sourceHeight: atlas.height,
    };
  }

  if (cutoutMode !== "aliyun" && isComfyUiConfigured()) {
    try {
      if (!(await comfyUiAvailable(Math.min(1_200, deadlineAt - Date.now())))) {
        throw new Error("ComfyUI 服务未启动或无法连接");
      }
      const result = await segmentWithComfyUi(sourceBuffer, options, deadlineAt);
      if (cutoutMode === "hybrid" && result.quality !== "good") {
        throw new Error("ComfyUI 蒙版未通过完整度检查");
      }
      return result;
    } catch (error) {
      if (cutoutMode === "comfyui") throw error;
    }
  } else if (cutoutMode === "comfyui") {
    throw new Error("尚未配置 COMFYUI_BASE_URL");
  }

  const resultUrl = await withProviderStartLimit(
    () => segmentResultUrl(sourceBuffer, api, deadlineAt),
    deadlineAt,
  );
  if (!resultUrl) throw new Error("专用抠图服务未返回图片");
  const resultBuffer = await fetchResultBuffer(resultUrl, deadlineAt);
  const pipeline = sharp(resultBuffer).rotate();
  const bytes = options.preserveGeometry
    ? await pipeline
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer()
    : await pipeline
      .resize(1024, 1024, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 1 },
        withoutEnlargement: true,
      })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4", mozjpeg: true })
      .toBuffer();
  const foregroundRatio = await whiteForegroundRatio(bytes);

  return {
    bytes,
    contentType: "image/jpeg",
    elapsedMs: Math.round(performance.now() - startedAt),
    provider: "aliyun-viapi",
    geometry: options.preserveGeometry ? "source" : "square-1024",
    quality: foregroundRatio >= 0.008 && foregroundRatio <= 0.92 ? "good" : "review",
    foregroundRatio,
  };
}
