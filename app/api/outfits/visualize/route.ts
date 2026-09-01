import { createHash } from "node:crypto";
import sharp from "sharp";
import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { getOwner, ownerJson, withOwnerCookie } from "../../../lib/owner";
import { dbAll, dbFirst } from "../../../lib/db";
import { storageGet, storagePut } from "../../../lib/storage";
import { apiErrorResponse, logServerEvent } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";
import {
  completeAiTask,
  ensureAiTaskSchema,
  failAiTask,
  getAiTask,
  readIdempotencyKey,
  startAiTask,
  taskPayload,
  type AiTask,
} from "../../../lib/ai-tasks";

type ImageRow = { id: string; name: string; category: string; imageKey: string };

type ArkPayload = {
  data?: Array<{ b64_json?: string; url?: string; output_format?: string; error?: { message?: string; code?: string } }>;
  error?: { message?: string; code?: string };
};

type GeneratedImage = {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  providerMs: number;
  fastPromptUsed: boolean;
  fastPromptFallback: boolean;
};

type CachedGeneration = GeneratedImage & {
  preprocessMs: number;
  finalizeMs: number;
  inputBytes: number;
  storageMs: number;
  outputWidth: number;
  outputHeight: number;
};

type ImageDimensions = { width: number; height: number };

const DEFAULT_ARK_MODEL = "doubao-seedream-5-0-lite-260128";
// This value is a pixel-budget fallback. The actual W×H follows the uploaded
// profile photo's aspect ratio so the provider never forces every user into 3:4.
const DEFAULT_ARK_SIZE = "1728x2304";
const MIN_SAFE_ARK_PIXELS = 2_560 * 1_440;
const MAX_SAFE_ARK_PIXELS = 4_096 * 4_096;
const SEMANTIC_CACHE_VERSION = "outfit-visualization-v4-source-frame";
const PROMPT_VERSION = "tryon-prompt-v4-identity-lock";
const inFlightSemanticGenerations = new Map<string, Promise<CachedGeneration>>();

function normalizedText(value: FormDataEntryValue | null, fallback: string, maxLength: number) {
  return String(value || fallback).trim().replace(/\s+/g, " ").slice(0, maxLength) || fallback;
}

function validatedExplicitArkSize(configured: string) {
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(configured);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width / height, height / width);
  return pixels >= MIN_SAFE_ARK_PIXELS && pixels <= MAX_SAFE_ARK_PIXELS && ratio <= 3
    ? { width, height }
    : null;
}

function roundToProviderPixels(value: number) {
  return Math.max(16, Math.round(value / 8) * 8);
}

function sizeForSourceAspect(targetPixels: number, source: ImageDimensions) {
  const sourceRatio = Math.min(3, Math.max(1 / 3, source.width / source.height));
  let width = roundToProviderPixels(Math.sqrt(targetPixels * sourceRatio));
  let height = roundToProviderPixels(Math.sqrt(targetPixels / sourceRatio));
  const pixels = width * height;
  if (pixels < MIN_SAFE_ARK_PIXELS) {
    const scale = Math.sqrt(MIN_SAFE_ARK_PIXELS / pixels);
    width = roundToProviderPixels(width * scale);
    height = roundToProviderPixels(height * scale);
  } else if (pixels > MAX_SAFE_ARK_PIXELS) {
    const scale = Math.sqrt(MAX_SAFE_ARK_PIXELS / pixels);
    width = roundToProviderPixels(width * scale);
    height = roundToProviderPixels(height * scale);
  }
  return `${width}x${height}`;
}

function resolveArkSize(source: ImageDimensions) {
  const configured = getServerEnv("ARK_IMAGE_SIZE");
  if (["2K", "3K", "4K"].includes(configured.toUpperCase())) return configured.toUpperCase();
  const requested = validatedExplicitArkSize(configured) || validatedExplicitArkSize(DEFAULT_ARK_SIZE)!;
  return sizeForSourceAspect(requested.width * requested.height, source);
}

function supportsFastPromptOptimization(model: string) {
  const configured = getServerEnv("ARK_OPTIMIZE_PROMPT_MODE").toLowerCase();
  if (configured === "fast") return true;
  if (configured === "standard" || configured === "off" || configured === "disabled") return false;
  // Officially, fast is currently unavailable on Seedream 5.0 lite and 4.5.
  return /seedream-(?:5-0-pro|4-0)(?:-|$)/i.test(model);
}

function supportsJpegOutput(model: string) {
  // Keep custom endpoint IDs compatible: only send this newer option when the
  // configured model name positively identifies a supporting 5.0 variant.
  return /seedream-5-0-(?:pro|lite)(?:-|$)/i.test(model);
}

async function optimizedImageDataUrl(key: string, maxEdge: number, quality: number) {
  const object = await storageGet(key);
  if (!object) throw new Error("生成所需的图片不存在");
  const bytes = await sharp(object.body, { failOn: "none", limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, chromaSubsampling: "4:2:0", progressive: false })
    .toBuffer();
  return {
    dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
    byteLength: bytes.byteLength,
  };
}

async function storedImageDimensions(key: string): Promise<ImageDimensions> {
  const object = await storageGet(key);
  if (!object) throw new Error("个人全身照不存在，请重新上传");
  const metadata = await sharp(object.body, { failOn: "none", limitInputPixels: 80_000_000 }).metadata();
  const width = metadata.autoOrient?.width || metadata.width;
  const height = metadata.autoOrient?.height || metadata.height;
  if (!width || !height) throw new Error("无法读取个人全身照尺寸，请重新上传");
  return { width, height };
}

async function finalizeToSourceDimensions(generated: GeneratedImage, source: ImageDimensions) {
  const startedAt = performance.now();
  const bytes = await sharp(generated.bytes, { failOn: "none", limitInputPixels: 80_000_000 })
    .rotate()
    .resize(source.width, source.height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4", progressive: false })
    .toBuffer();
  return {
    ...generated,
    bytes: Uint8Array.from(bytes),
    contentType: "image/jpeg",
    finalizeMs: Math.round(performance.now() - startedAt),
    outputWidth: source.width,
    outputHeight: source.height,
  };
}

function arkError(payload: ArkPayload) {
  const nested = payload.data?.find(item => item.error)?.error;
  return payload.error || nested;
}

function shouldRetryWithoutFast(status: number, payload: ArkPayload) {
  if (status !== 400 && status !== 422) return false;
  const error = arkError(payload);
  return /optimize[_ ]?prompt|fast|mode|unsupported|not support|invalid parameter/i.test(`${error?.code || ""} ${error?.message || ""}`);
}

async function requestArkImage(images: string[], prompt: string, model: string, size: string, useFastPrompt: boolean) {
  const body: Record<string, unknown> = {
    model,
    prompt,
    image: images,
    size,
    response_format: "url",
    sequential_image_generation: "disabled",
    stream: false,
    watermark: false,
  };
  if (supportsJpegOutput(model)) body.output_format = "jpeg";
  if (useFastPrompt) body.optimize_prompt_options = { mode: "fast" };
  const response = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${requireServerEnv("ARK_API_KEY")}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({})) as ArkPayload;
  return { response, payload };
}

async function generateTryOnImage(images: string[], prompt: string, model: string, size: string): Promise<GeneratedImage> {
  const startedAt = performance.now();
  const fastPromptRequested = supportsFastPromptOptimization(model);
  let attempt = await requestArkImage(images, prompt, model, size, fastPromptRequested);
  let fastPromptFallback = false;
  if (fastPromptRequested && !attempt.response.ok && shouldRetryWithoutFast(attempt.response.status, attempt.payload)) {
    fastPromptFallback = true;
    logServerEvent("warn", "outfit_visualization_fast_prompt_fallback", {
      model,
      provider_status: attempt.response.status,
      provider_code: arkError(attempt.payload)?.code,
    });
    attempt = await requestArkImage(images, prompt, model, size, false);
  }
  const image = attempt.payload.data?.[0];
  if (!attempt.response.ok || (!image?.b64_json && !image?.url)) {
    const error = arkError(attempt.payload);
    throw new Error(error?.message || error?.code || "个人穿搭效果图生成失败");
  }
  if (image.b64_json) {
    return {
      bytes: Uint8Array.from(Buffer.from(image.b64_json, "base64")),
      contentType: image.output_format === "png" ? "image/png" : "image/jpeg",
      providerMs: Math.round(performance.now() - startedAt),
      fastPromptUsed: fastPromptRequested && !fastPromptFallback,
      fastPromptFallback,
    };
  }
  const generated = await fetch(image.url!, { signal: AbortSignal.timeout(6_000) });
  if (!generated.ok) throw new Error("效果图下载失败");
  return {
    bytes: new Uint8Array(await generated.arrayBuffer()),
    contentType: generated.headers.get("Content-Type") || (supportsJpegOutput(model) ? "image/jpeg" : "image/png"),
    providerMs: Math.round(performance.now() - startedAt),
    fastPromptUsed: fastPromptRequested && !fastPromptFallback,
    fastPromptFallback,
  };
}

function semanticCacheHash(input: {
  ownerId: string;
  profileImageVersion: string;
  garmentImageVersions: string[];
  scene: string;
  prompt: string;
  model: string;
  size: string;
  outputWidth: number;
  outputHeight: number;
}) {
  return createHash("sha256").update(JSON.stringify({ version: SEMANTIC_CACHE_VERSION, promptVersion: PROMPT_VERSION, ...input })).digest("hex");
}

function buildTryOnPrompt(items: ImageRow[], scene: string, userPrompt: string, source: ImageDimensions) {
  const references = items.map((item, index) => `图${index + 2}是${item.name}（${item.category}）`).join("；");
  return `这是对图1的局部穿搭替换，不是重新生成人物。图1是用户原始全身照，${references}。将图2至图${items.length + 1}的全部单品按真实类别穿戴到图1人物身上，不得遗漏、替换或新增单品，并保留每件的主色、版型、长度、材质、纹理和图案。人物一致性为最高优先级：严格保持图1人物的五官、脸型、年龄、性别、发型发色、肤色、妆容、身材比例、手脚、姿势、视线和表情，不要换脸、美颜、瘦身、增高或改变体态。画面一致性：保持图1原始背景、相机角度、镜头距离、透视、人物位置、裁切范围、光线和阴影，仅修改衣服、鞋帽、包和配饰对应区域；除穿搭替换区域外，其余内容尽可能保持不变。输出必须沿用图1的原始宽高比 ${source.width}:${source.height}，完整保留原画面边界，不得裁切、扩图或改成其他画幅，最终文件由系统还原为 ${source.width}x${source.height} 像素。使用场景：${scene}。补充穿搭要求：${userPrompt}。写实自然，衣物结构与穿着关系真实，无文字、水印、边框、多人或多余肢体。`;
}

function sharedSemanticGeneration(key: string, generate: () => Promise<CachedGeneration>) {
  const running = inFlightSemanticGenerations.get(key);
  if (running) return { promise: running, joined: true };
  const promise = generate().finally(() => inFlightSemanticGenerations.delete(key));
  inFlightSemanticGenerations.set(key, promise);
  return { promise, joined: false };
}

function generatedImageResponse(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  owner: ReturnType<typeof getOwner>,
  taskId: string,
  values: {
    cache: "HIT" | "MISS" | "COALESCED" | "TASK";
    totalMs: number;
    cacheMs?: number;
    preprocessMs?: number;
    providerMs?: number;
    finalizeMs?: number;
    storageMs?: number;
    outputWidth?: number;
    outputHeight?: number;
  },
) {
  const serverTiming = [
    values.cacheMs === undefined ? "" : `semantic-cache;dur=${values.cacheMs}`,
    values.preprocessMs === undefined ? "" : `preprocess;dur=${values.preprocessMs}`,
    values.providerMs === undefined ? "" : `seedream;dur=${values.providerMs}`,
    values.finalizeMs === undefined ? "" : `source-size-finalize;dur=${values.finalizeMs}`,
    values.storageMs === undefined ? "" : `storage;dur=${values.storageMs}`,
  ].filter(Boolean).join(", ");
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    "X-Yida-Output": "personal-outfit-preview",
    "X-Yida-Task-Id": taskId,
    "X-Layra-Provider": "volcengine-seedream",
    "X-Layra-Cache": values.cache,
    "X-Layra-Latency-Ms": String(values.totalMs),
  });
  if (values.outputWidth && values.outputHeight) {
    headers.set("X-Layra-Output-Size", `${values.outputWidth}x${values.outputHeight}`);
  }
  if (serverTiming) headers.set("Server-Timing", serverTiming);
  return withOwnerCookie(new Response(bytes, { headers }), owner);
}

async function storedResult(task: AiTask, owner: ReturnType<typeof getOwner>) {
  if (!task.resultKey) return ownerJson({ error: "效果图结果不完整，请重新生成" }, owner, 500);
  const object = await storageGet(task.resultKey);
  if (!object) return ownerJson({ error: "效果图已过期，请重新生成" }, owner, 410);
  const headers = new Headers({
    "Content-Type": task.resultContentType || object.contentType || "image/png",
    "Cache-Control": "private, no-store",
    "X-Yida-Output": "personal-outfit-preview",
    "X-Yida-Task-Id": task.id,
    "X-Layra-Cache": "TASK",
  });
  try {
    const requestSummary = JSON.parse(task.requestJson) as { outputWidth?: number; outputHeight?: number };
    if (requestSummary.outputWidth && requestSummary.outputHeight) {
      headers.set("X-Layra-Output-Size", `${requestSummary.outputWidth}x${requestSummary.outputHeight}`);
    }
  } catch {
    // Older tasks did not record source dimensions.
  }
  return withOwnerCookie(new Response(object.body, { headers }), owner);
}

async function handleGET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureAiTaskSchema();
    const taskId = new URL(request.url).searchParams.get("taskId") || "";
    const task = await getAiTask(owner.id, "outfit-visualization", taskId);
    if (!task) return ownerJson({ error: "没有找到这次效果图任务" }, owner, 404);
    if (task.status === "succeeded") return storedResult(task, owner);
    if (task.status === "failed") return ownerJson({ task: taskPayload(task), error: "效果图生成失败，请点击重试" }, owner, 409);
    return ownerJson({ task: taskPayload(task) }, owner, 202);
  } catch (error) {
    return apiErrorResponse(request, error, "效果图任务查询失败");
  }
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  const startedAt = performance.now();
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return ownerJson({ error: "请刷新页面后重新生成", code: "INVALID_IDEMPOTENCY_KEY" }, owner, 400);
  let taskId = "";
  try {
    await ensureAiTaskSchema();
    const existing = await getAiTask(owner.id, "outfit-visualization", idempotencyKey);
    if (existing?.status === "succeeded") return storedResult(existing, owner);
    if (existing?.status === "failed") return ownerJson({ task: taskPayload(existing), error: "上次效果图生成失败，请点击重试" }, owner, 409);
    if (existing) return ownerJson({ task: taskPayload(existing) }, owner, 202);
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) return ownerJson({ error: "请刷新页面后重新生成效果图" }, owner, 400);
    const form = await request.formData();
    let submittedIds: unknown = [];
    try { submittedIds = JSON.parse(String(form.get("itemIds") || "[]")); } catch { submittedIds = []; }
    const itemIds = [...new Set((Array.isArray(submittedIds) ? submittedIds : []).map(String))].slice(0, 6);
    if (!itemIds.length) return ownerJson({ error: "请先选择一套搭配" }, owner, 400);
    const profile = await dbFirst<{ imageKey: string; contentType: string }>("SELECT image_key AS imageKey, content_type AS contentType FROM model_profiles WHERE owner_id = ?", [owner.id]);
    if (!profile) return ownerJson({ error: "请先上传一张清晰的个人全身照" }, owner, 400);
    const sourceDimensions = await storedImageDimensions(profile.imageKey);
    const placeholders = itemIds.map(() => "?").join(",");
    const rows = await dbAll<ImageRow>(`SELECT id, name, category, image_key AS imageKey FROM wardrobe_items
      WHERE owner_id = ? AND status = 'available' AND id IN (${placeholders})`, [owner.id, ...itemIds]);
    if (rows.length !== itemIds.length) return ownerJson({ error: "搭配中的部分衣物已不在衣柜，请重新推荐" }, owner, 409);
    // The provider does not care about selection order. A stable image-version order
    // makes semantically identical requests share the same prompt and cache entry.
    const ordered = rows.slice().sort((left, right) => {
      if (left.imageKey < right.imageKey) return -1;
      if (left.imageKey > right.imageKey) return 1;
      return left.id.localeCompare(right.id);
    });
    const title = normalizedText(form.get("title"), "今日搭配", 30);
    const scene = normalizedText(form.get("scene"), "日常", 20);
    const userPrompt = normalizedText(form.get("prompt"), "自然、舒适、比例协调", 180);
    const model = getServerEnv("ARK_IMAGE_MODEL") || DEFAULT_ARK_MODEL;
    const size = resolveArkSize(sourceDimensions);
    const garmentImageVersions = ordered.map(item => item.imageKey);
    const semanticHash = semanticCacheHash({
      ownerId: owner.id,
      profileImageVersion: profile.imageKey,
      garmentImageVersions,
      scene,
      prompt: userPrompt,
      model,
      size,
      outputWidth: sourceDimensions.width,
      outputHeight: sourceDimensions.height,
    });
    const resultKey = `outfit-results/semantic-v3/${owner.id}/${semanticHash}`;
    const requestSummary = JSON.stringify({
      itemIds,
      title,
      scene,
      prompt: userPrompt,
      profileImageVersion: profile.imageKey,
      garmentImageVersions,
      model,
      size,
      outputWidth: sourceDimensions.width,
      outputHeight: sourceDimensions.height,
      semanticHash,
    });
    const started = await startAiTask(owner.id, "outfit-visualization", idempotencyKey, requestSummary);
    taskId = started.task.id;
    if (!started.created) {
      if (started.task.status === "succeeded") return storedResult(started.task, owner);
      if (started.task.status === "failed") return ownerJson({ task: taskPayload(started.task), error: "上次效果图生成失败，请点击重试" }, owner, 409);
      return ownerJson({ task: taskPayload(started.task) }, owner, 202);
    }
    const cacheStartedAt = performance.now();
    const cached = await storageGet(resultKey);
    const cacheMs = Math.round(performance.now() - cacheStartedAt);
    if (cached?.body.byteLength) {
      const resultContentType = cached.contentType || "image/jpeg";
      await completeAiTask(taskId, { resultKey, resultContentType });
      const totalMs = Math.round(performance.now() - startedAt);
      logServerEvent("info", "outfit_visualization_cache_hit", {
        total_ms: totalMs,
        cache_ms: cacheMs,
        item_count: ordered.length,
        model,
        size,
      });
      return generatedImageResponse(cached.body, resultContentType, owner, taskId, {
        cache: "HIT",
        totalMs,
        cacheMs,
        outputWidth: sourceDimensions.width,
        outputHeight: sourceDimensions.height,
      });
    }

    const tryOnPrompt = buildTryOnPrompt(ordered, scene, userPrompt, sourceDimensions);
    const shared = sharedSemanticGeneration(resultKey, async () => {
      const preprocessStartedAt = performance.now();
      const optimizedImages = await Promise.all([
        optimizedImageDataUrl(profile.imageKey, 2048, 92),
        ...ordered.map(item => optimizedImageDataUrl(item.imageKey, 640, 84)),
      ]);
      const preprocessMs = Math.round(performance.now() - preprocessStartedAt);
      const generated = await generateTryOnImage(
        optimizedImages.map(image => image.dataUrl),
        tryOnPrompt,
        model,
        size,
      );
      const finalized = await finalizeToSourceDimensions(generated, sourceDimensions);
      const storageStartedAt = performance.now();
      await storagePut(resultKey, finalized.bytes, finalized.contentType);
      const storageMs = Math.round(performance.now() - storageStartedAt);
      return {
        ...finalized,
        preprocessMs,
        inputBytes: optimizedImages.reduce((sum, image) => sum + image.byteLength, 0),
        storageMs,
      };
    });
    const generated = await shared.promise;
    await completeAiTask(taskId, { resultKey, resultContentType: generated.contentType });
    const totalMs = Math.round(performance.now() - startedAt);
    logServerEvent("info", "outfit_visualization_completed", {
      provider: "volcengine-seedream",
      provider_ms: generated.providerMs,
      preprocess_ms: generated.preprocessMs,
      finalize_ms: generated.finalizeMs,
      storage_ms: generated.storageMs,
      total_ms: totalMs,
      input_bytes: generated.inputBytes,
      item_count: ordered.length,
      model,
      size,
      output_width: generated.outputWidth,
      output_height: generated.outputHeight,
      cache: shared.joined ? "coalesced" : "miss",
      fast_prompt_used: generated.fastPromptUsed,
      fast_prompt_fallback: generated.fastPromptFallback,
    });
    return generatedImageResponse(generated.bytes, generated.contentType, owner, taskId, {
      cache: shared.joined ? "COALESCED" : "MISS",
      totalMs,
      cacheMs,
      preprocessMs: generated.preprocessMs,
      providerMs: generated.providerMs,
      finalizeMs: generated.finalizeMs,
      storageMs: generated.storageMs,
      outputWidth: generated.outputWidth,
      outputHeight: generated.outputHeight,
    });
  } catch (error) {
    if (taskId) await failAiTask(taskId, error).catch(() => undefined);
    return apiErrorResponse(request, error, "个人穿搭效果图生成失败");
  }
}

export function GET(request: Request) {
  return withProtectedApiRequest(request, handleGET, "效果图任务查询失败");
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "个人穿搭效果图生成失败");
}
