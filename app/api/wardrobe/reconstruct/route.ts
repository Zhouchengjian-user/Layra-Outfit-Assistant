import { createHash } from "node:crypto";
import sharp from "sharp";
import { requireSession, responseForAuthError } from "../../../lib/auth";
import { apiErrorResponse, logServerEvent } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";
import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { inspectGarmentComponents } from "../../../lib/garment-component-quality";

type DashScopeImagePayload = {
  output?: {
    choices?: Array<{
      message?: { content?: Array<{ image?: string; type?: string }> };
    }>;
  };
  code?: string;
  message?: string;
};

type ArkImagePayload = {
  data?: Array<{
    b64_json?: string;
    url?: string;
    output_format?: string;
    error?: { message?: string; code?: string };
  }>;
  error?: { message?: string; code?: string };
};

type ReconstructionProvider = "aliyun-bailian" | "volcengine-seedream";

type ReconstructionResult = {
  bytes: Buffer;
  model: string;
  provider: ReconstructionProvider;
  providerMs: number;
  completeness: "pass" | "review";
  componentCount: number;
  allowedComponents: number;
};

type ReconstructionRequest = {
  source: Buffer;
  sourceType: string;
  visible?: Buffer;
  visibleType?: string;
  category: string;
  color: string;
  description: string;
  model: string;
  size: string;
  candidates: number;
  arkModel: string;
  arkSize: string;
  arkCandidates: number;
};

const DEFAULT_MODEL = "qwen-image-2.0";
const DEFAULT_SIZE = "1024*1024";
const DEFAULT_CANDIDATES = 2;
const DEFAULT_ARK_MODEL = "doubao-seedream-5-0-lite-260128";
const DEFAULT_ARK_SIZE = "1920x1920";
const DEFAULT_ARK_CANDIDATES = 2;
const MIN_SAFE_ARK_PIXELS = 2_560 * 1_440;
const MAX_SAFE_ARK_PIXELS = 4_096 * 4_096;
const PROMPT_VERSION = "garment-reconstruction-v4";
const resultCache = new Map<string, ReconstructionResult>();
const inFlight = new Map<string, Promise<ReconstructionResult>>();
const maxCacheEntries = 30;
const maxCacheBytes = 28 * 1024 * 1024;
const providerWaiters: Array<() => void> = [];
let cachedBytes = 0;
let activeProviderRequests = 0;
const maxConcurrentProviderRequests = 1;
const providerRequestTimeoutMs = 35_000;
const reconstructionDeadlineMs = 90_000;
const aliyunAccountFailurePattern = /arrearage|invalid.?api.?key|invalid.?access.?key|unauthori[sz]ed|authentication|access.?denied|forbidden|no.?permission|insufficient.?balance|balance.?not.?enough|account.?(?:suspend|freeze)|billing/i;

class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly code = "",
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

class ReconstructionDeadlineError extends Error {
  constructor() {
    super("完整衣物商品图生成超时，请重试");
    this.name = "ReconstructionDeadlineError";
  }
}

function normalizedField(value: FormDataEntryValue | null, fallback: string, maxLength: number) {
  return String(value || fallback).trim().replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, maxLength) || fallback;
}

function completionChecklist(category: string, description: string) {
  if (category === "上衣") {
    if (/无袖|背心/.test(description)) return "严格保持无袖，完整展示左右两个袖窿，绝对不能添加长袖、短袖、套袖或分离袖片；完整展示领口、左右肩线、双侧缝和衣摆";
    if (/短袖/.test(description)) return "严格保持原本短袖长度，完整展示左右短袖与袖口、领口、左右肩线、双侧缝和衣摆";
    if (/长袖/.test(description)) return "严格保持原本长袖长度，完整展示左右长袖与袖口、领口、左右肩线、双侧缝和衣摆";
    return "准确保持原图中的袖型，不增加原图不存在的部件；完整展示领口、左右肩线、双侧缝和衣摆";
  }
  if (category === "外套") return "完整领口或驳领、双肩、双袖与袖口、前门襟、闭合结构、双侧缝和完整衣摆";
  if (category === "裤子") return "完整腰头、门襟、口袋、两条完整裤腿和两个完整裤脚";
  if (category === "裙子") return "完整腰头、双侧缝、裙身和从左到右连续完整的下摆";
  if (category === "连衣裙") return "准确保持原衣袖型，完整展示领口、双肩、两个袖口或袖窿、腰部、裙身和连续完整的下摆";
  if (category === "鞋子") return "一双鞋的完整鞋头、鞋面、鞋帮、鞋跟与鞋底，左右鞋均不被裁切";
  if (category === "包") return "完整包身、包口、提手或肩带、底部和所有可见五金";
  if (category === "帽子") return "完整帽顶、帽身、帽檐或帽缘";
  return "完整外轮廓、连接结构与所有可见细节";
}

function excludedItems(category: string) {
  if (category === "上衣") return "输出中禁止出现裤子、裙子、下装、鞋、包或成套穿搭";
  if (category === "外套") return "输出中禁止出现内搭、裤子、裙子、鞋、包或成套穿搭";
  if (category === "裤子") return "输出中禁止出现上衣、裙子、鞋、包或成套穿搭";
  if (category === "裙子" || category === "连衣裙") return "输出中禁止出现裤子、其他上衣、鞋、包或成套穿搭";
  if (category === "鞋子") return "输出中只能出现同一双鞋，禁止出现腿、裤脚、衣服、包或其他鞋款";
  return "输出中禁止出现人物、其他衣物、搭配单品或成套穿搭";
}

function buildPrompt(category: string, color: string, description: string, hasVisibleReference: boolean) {
  const sourceDescription = hasVisibleReference
    ? "图1是原始人物或场景照片，图2是目标单品所在的局部识别参考，可能仍包含人物或相邻衣物；只提取指定品类和颜色的目标单品。"
    : "图1是原始人物或场景照片。";
  const targetReference = hasVisibleReference ? "图2局部中可见的" : "图1中的";
  const structureReference = description
    ? `已识别的原衣结构是：${description}。必须以原图为准核对这段描述，不得擅自改变袖型、领型、长度、口袋、图案或破洞状态。\n`
    : "";
  return `${sourceDescription}
任务：只把${targetReference}${color}${category}制作成一张完整的正面电商白底商品图。输出中只能有这一件目标${category}，${excludedItems(category)}。
${structureReference}结构硬性要求：${completionChecklist(category, description)}。原本相连的结构必须自然连接，不能出现分离部件或额外部件。
保持原衣颜色、领型、袖型、长度、版型、面料、口袋、五金、印花与图案；只补全被人体遮挡的部分。不得把人体、褶皱、阴影或高光画成破洞，原图没有破洞就不得新增破洞、撕裂或缺口。
移除人物、皮肤、头发、手脚、其他衣物和原背景。目标单品正面平铺、居中、端正，缩小到画面约70%，任何部位不得裁切，四周至少保留10%纯白#FFFFFF留白。无文字、无水印、无边框。`;
}

function retryInstruction(category: string) {
  return `\n这是严格纠错重做：最后一张参考图是上一次未通过完整性检查的候选。在保留其正确颜色、材质和款式的基础上，修复被裁切、缺失或断开的结构。只输出一件${category}，不要输出整套穿搭或任何其他单品；目标缩小并完整置于白色画布中央，所有原本相连的结构必须相连。`;
}

function negativePrompt(category: string, description: string) {
  const common = "人物，模特，人体，皮肤，头发，手，脚，其他衣物，多件商品，整套穿搭，拼图，衣架，假人，裁切，局部，残缺，分离部件，破洞，撕裂，缺口，图案改变，文字变形，颜色改变，水印";
  if (category === "上衣") {
    const sleeveConstraint = /无袖|背心/.test(description) ? "，长袖，短袖，套袖，分离袖片" : "，套袖，分离袖片";
    return `${common}，裤子，裙子，鞋，包${sleeveConstraint}`;
  }
  if (category === "裤子") return `${common}，上衣，裙子，鞋，包，缺腰头，缺裤脚`;
  if (category === "裙子" || category === "连衣裙") return `${common}，裤子，鞋，包`;
  return common;
}

function supportsQwenParameters(model: string) {
  return /^qwen-image-(?:2\.0|3\.0)/i.test(model) || /^qwen-image-edit-(?:max|plus)/i.test(model);
}

function resolveArkReconstructionSize() {
  const configured = getServerEnv("ARK_GARMENT_RECONSTRUCTION_SIZE") || getServerEnv("ARK_IMAGE_SIZE");
  if (!configured) return DEFAULT_ARK_SIZE;
  if (["2K", "3K", "4K"].includes(configured.toUpperCase())) return configured.toUpperCase();
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(configured);
  if (!match) return DEFAULT_ARK_SIZE;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width / height, height / width);
  return pixels >= MIN_SAFE_ARK_PIXELS && pixels <= MAX_SAFE_ARK_PIXELS && ratio <= 16
    ? `${width}x${height}`
    : DEFAULT_ARK_SIZE;
}

function supportsArkJpegOutput(model: string) {
  return /seedream-5-0-(?:pro|lite)(?:-|$)/i.test(model);
}

async function withProviderSlot<T>(task: () => Promise<T>, maxWaitMs = reconstructionDeadlineMs) {
  // The image-edit endpoint becomes much less reliable when a full outfit
  // fans out into many simultaneous requests. Queue them and let cards finish
  // one by one; the client already shows progressive previews.
  if (activeProviderRequests >= maxConcurrentProviderRequests) {
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        clearTimeout(timeout);
        resolve();
      };
      providerWaiters.push(grant);
      const timeout = setTimeout(() => {
        const index = providerWaiters.indexOf(grant);
        if (index >= 0) providerWaiters.splice(index, 1);
        reject(new ReconstructionDeadlineError());
      }, Math.max(1, maxWaitMs));
    });
  } else {
    activeProviderRequests += 1;
  }
  try {
    return await task();
  } finally {
    const next = providerWaiters.shift();
    if (next) next();
    else activeProviderRequests -= 1;
  }
}

function retryDelay(milliseconds: number) {
  return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}

function isTransientProviderError(error: unknown) {
  if (error instanceof ProviderRequestError) return error.retryable;
  if (error instanceof ReconstructionDeadlineError) return false;
  const name = error instanceof Error ? error.name : "";
  return error instanceof TypeError || name === "AbortError" || name === "TimeoutError";
}

function isAliyunAccountFailure(error: unknown) {
  if (error instanceof ProviderRequestError) {
    if (error.status === 401 || error.status === 403) return true;
    return aliyunAccountFailurePattern.test(`${error.code} ${error.message}`);
  }
  return error instanceof Error && /服务端缺少\s+DASHSCOPE_API_KEY\s+配置/.test(error.message);
}

async function inspectCompleteness(bytes: Buffer, category: string) {
  const { data, info } = await sharp(bytes, { failOn: "none", limitInputPixels: 80_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(192, 192, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const cornerSize = 10;
  const cornerPixels: number[][] = [];
  for (const [originX, originY] of [[0, 0], [192 - cornerSize, 0], [0, 192 - cornerSize], [192 - cornerSize, 192 - cornerSize]]) {
    for (let y = originY; y < originY + cornerSize; y++) {
      for (let x = originX; x < originX + cornerSize; x++) {
        const offset = (y * 192 + x) * channels;
        cornerPixels.push([data[offset], data[offset + 1], data[offset + 2]]);
      }
    }
  }
  const background = [0, 1, 2].map(channel => cornerPixels.reduce((sum, pixel) => sum + pixel[channel], 0) / cornerPixels.length);
  let foreground = 0;
  const componentForegroundMask = new Uint8Array(192 * 192);
  for (let y = 0; y < 192; y++) {
    for (let x = 0; x < 192; x++) {
      const offset = (y * 192 + x) * channels;
      const distance = Math.sqrt(
        (data[offset] - background[0]) ** 2
        + (data[offset + 1] - background[1]) ** 2
        + (data[offset + 2] - background[2]) ** 2,
      );
      const brightnessDrop = (background[0] + background[1] + background[2] - data[offset] - data[offset + 1] - data[offset + 2]) / 3;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const average = (red + green + blue) / 3;
      const saturation = Math.max(red, green, blue) - Math.min(red, green, blue);
      // Exclude pale product shadows: they can visually bridge separate items
      // and make a multi-garment result look like one connected component.
      if (average < 230 || saturation > 18) componentForegroundMask[y * 192 + x] = 1;
      if (distance < 18 && brightnessDrop < 12) continue;
      foreground += 1;
    }
  }
  const cornersAreLight = background.every(value => value >= 235);
  const hasSubject = foreground >= 192 * 192 * 0.015;
  const components = inspectGarmentComponents(componentForegroundMask, 192, 192, category);
  const sourceMargin = hasSubject && components.significantBounds
    ? Math.min(
      components.significantBounds[0],
      components.significantBounds[1],
      191 - components.significantBounds[2],
      191 - components.significantBounds[3],
    ) / 192
    : 0;
  return {
    completeness: cornersAreLight && hasSubject && sourceMargin >= 0.005 && components.status === "pass"
      ? "pass" as const
      : "review" as const,
    components,
  };
}

async function normalizeProductImage(
  bytes: Buffer,
  significantBounds: [number, number, number, number] | null,
) {
  const flattened = await sharp(bytes, { failOn: "none", limitInputPixels: 80_000_000 })
    .rotate()
    .flatten({ background: "#ffffff" })
    .toBuffer({ resolveWithObject: true });
  let productSource = flattened.data;
  let innerSize = 900;
  if (significantBounds) {
    const [minX, minY, maxX, maxY] = significantBounds;
    const scaleX = flattened.info.width / 192;
    const scaleY = flattened.info.height / 192;
    const subjectWidth = Math.max(scaleX, (maxX - minX + 1) * scaleX);
    const subjectHeight = Math.max(scaleY, (maxY - minY + 1) * scaleY);
    const padding = Math.max(10, Math.round(Math.max(subjectWidth, subjectHeight) * 0.045));
    const left = Math.max(0, Math.floor(minX * scaleX) - padding);
    const top = Math.max(0, Math.floor(minY * scaleY) - padding);
    const right = Math.min(flattened.info.width, Math.ceil((maxX + 1) * scaleX) + padding);
    const bottom = Math.min(flattened.info.height, Math.ceil((maxY + 1) * scaleY) + padding);
    if (right > left && bottom > top) {
      productSource = await sharp(flattened.data)
        .extract({ left, top, width: right - left, height: bottom - top })
        .toBuffer();
      // The cropped significant subject occupies roughly 72-78% of the final
      // square, leaving clean retail-style whitespace on every side.
      innerSize = 800;
    }
  }
  const inset = (1024 - innerSize) / 2;
  const normalized = await sharp(productSource, { failOn: "none", limitInputPixels: 80_000_000 })
    .resize(innerSize, innerSize, { fit: "contain", background: "#ffffff", withoutEnlargement: false })
    .extend({
      top: inset,
      bottom: inset,
      left: inset,
      right: inset,
      background: "#ffffff",
    })
    .jpeg({ quality: 91, chromaSubsampling: "4:4:4", progressive: false })
    .toBuffer();
  return normalized;
}

async function requestAliyunReconstruction(input: ReconstructionRequest, deadlineAt: number) {
  const startedAt = performance.now();
  const remainingMs = () => Math.max(0, Math.floor(deadlineAt - performance.now()));
  const imageContent: Array<{ image: string }> = [
    { image: `data:${input.sourceType};base64,${input.source.toString("base64")}` },
  ];
  if (input.visible) {
    imageContent.push({ image: `data:${input.visibleType || "image/jpeg"};base64,${input.visible.toString("base64")}` });
  }
  const prompt = buildPrompt(input.category, input.color, input.description, Boolean(input.visible));
  const endpoint = getServerEnv("DASHSCOPE_IMAGE_ENDPOINT")
    || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const seedHash = createHash("sha256")
    .update(input.source)
    .update(input.category)
    .update(input.color)
    .update(input.description)
    .digest();
  const baseSeed = seedHash.readUInt32BE(0) & 0x7fffffff;
  let bestCandidate: {
    rawBytes: Buffer;
    quality: Awaited<ReturnType<typeof inspectCompleteness>>;
  } | null = null;
  let lastError: unknown;
  let attemptedCandidates = 0;

  for (let index = 0; index < input.candidates; index++) {
    if (remainingMs() < 1_500) break;
    try {
      const content: Array<{ image: string } | { text: string }> = [
        ...imageContent,
        { text: prompt + (index > 0 ? retryInstruction(input.category) : "") },
      ];
      let imageUrl = "";
      // Provider throttling is transient. Retry the same candidate without
      // consuming one of the two quality candidates.
      for (let attempt = 0; attempt < 3 && !imageUrl; attempt++) {
        try {
          const waitBudget = remainingMs();
          if (waitBudget < 1_500) throw new ReconstructionDeadlineError();
          imageUrl = await withProviderSlot(async () => {
            const requestBudget = remainingMs();
            if (requestBudget < 1_500) throw new ReconstructionDeadlineError();
            const parameters: Record<string, unknown> = {
              n: 1,
              watermark: false,
              size: input.size,
              seed: (baseSeed + index * 104_729) % 2_147_483_647,
            };
            if (supportsQwenParameters(input.model)) {
              parameters.prompt_extend = false;
              parameters.negative_prompt = negativePrompt(input.category, input.description);
            }
            const response = await fetch(endpoint, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${requireServerEnv("DASHSCOPE_API_KEY")}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: input.model,
                input: { messages: [{ role: "user", content }] },
                parameters,
              }),
              signal: AbortSignal.timeout(Math.min(providerRequestTimeoutMs, requestBudget)),
            });
            const payload = await response.json().catch(() => ({})) as DashScopeImagePayload;
            const url = (payload.output?.choices || [])
              .flatMap(choice => choice.message?.content || [])
              .find(item => item.image)?.image || "";
            if (!response.ok || !url) {
              const message = payload.message || payload.code || "完整衣物商品图生成失败";
              const providerCode = `${payload.code || ""} ${payload.message || ""}`;
              const accountFailure = response.status === 401
                || response.status === 403
                || aliyunAccountFailurePattern.test(providerCode);
              const retryable = !accountFailure && (response.status === 429
                || response.status >= 500
                || /thrott|rate|quota|busy|timeout|internal|unavailable/i.test(providerCode));
              logServerEvent("warn", "wardrobe_reconstruction_provider_rejected", {
                model: input.model,
                status: response.status,
                code: payload.code || "missing_image",
                retryable,
              });
              throw new ProviderRequestError(message, retryable, response.status, payload.code || "");
            }
            return url;
          }, waitBudget);
        } catch (error) {
          lastError = error;
          const delayMs = 450 * (attempt + 1);
          if (attempt === 2 || !isTransientProviderError(error) || remainingMs() < delayMs + 1_500) throw error;
          await retryDelay(delayMs);
        }
      }
      const downloadBudget = remainingMs();
      if (downloadBudget < 1_000) throw new ReconstructionDeadlineError();
      const generated = await fetch(imageUrl, { signal: AbortSignal.timeout(Math.min(12_000, downloadBudget)) });
      if (!generated.ok) throw new ProviderRequestError("完整衣物商品图下载失败", generated.status === 429 || generated.status >= 500, generated.status);
      const rawBytes = Buffer.from(await generated.arrayBuffer());
      const quality = await inspectCompleteness(rawBytes, input.category);
      const candidate = { rawBytes, quality };
      bestCandidate ||= candidate;
      attemptedCandidates += 1;
      if (quality.completeness !== "pass" || quality.components.status !== "pass") continue;
      const bytes = await normalizeProductImage(rawBytes, quality.components.significantBounds);
      return {
        bytes,
        model: input.model,
        provider: "aliyun-bailian" as const,
        providerMs: Math.round(performance.now() - startedAt),
        completeness: quality.completeness,
        componentCount: quality.components.componentCount,
        allowedComponents: quality.components.allowedComponents,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof ReconstructionDeadlineError) break;
      if (error instanceof ProviderRequestError && !error.retryable) throw error;
    }
  }

  if (!bestCandidate) throw lastError || new Error("完整衣物商品图生成失败");
  const quality = bestCandidate.quality;
  const failureEvent = quality.components.status !== "pass"
    ? "wardrobe_reconstruction_disconnected"
    : "wardrobe_reconstruction_incomplete";
  logServerEvent("warn", failureEvent, {
    model: input.model,
    category: input.category,
    component_count: quality.components.componentCount,
    allowed_components: quality.components.allowedComponents,
    significant_component_sizes: quality.components.significantComponentSizes,
    candidate_count: attemptedCandidates,
  });
  throw new Error(quality.components.status !== "pass"
    ? "生成结果包含分离的衣物部件，请重新生成"
    : "生成结果未完整进入画面，请重新生成");
}

function arkPayloadError(payload: ArkImagePayload) {
  const nested = payload.data?.find(item => item.error)?.error;
  return payload.error || nested;
}

async function arkInputDataUrl(bytes: Buffer, maxEdge: number) {
  const optimized = await sharp(bytes, { failOn: "none", limitInputPixels: 80_000_000 })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 88, chromaSubsampling: "4:2:0", progressive: false })
    .toBuffer();
  return `data:image/jpeg;base64,${optimized.toString("base64")}`;
}

async function requestArkReconstruction(input: ReconstructionRequest, deadlineAt: number) {
  const startedAt = performance.now();
  const remainingMs = () => Math.max(0, Math.floor(deadlineAt - performance.now()));
  const inputImages = await Promise.all([
    arkInputDataUrl(input.source, 1_536),
    ...(input.visible ? [arkInputDataUrl(input.visible, 1_024)] : []),
  ]);
  const prompt = buildPrompt(input.category, input.color, input.description, Boolean(input.visible));
  let bestCandidate: {
    rawBytes: Buffer;
    quality: Awaited<ReturnType<typeof inspectCompleteness>>;
  } | null = null;
  let correctionReference = "";
  // Return the first valid image immediately. Only spend a second generation
  // when the first one loses a waist, hem or another connected structure.
  const candidateCount = input.arkCandidates;
  let lastError: unknown;

  for (let index = 0; index < candidateCount; index++) {
    try {
      const waitBudget = remainingMs();
      if (waitBudget < 1_500) throw new ReconstructionDeadlineError();
      const attempt = await withProviderSlot(async () => {
        const requestBudget = remainingMs();
        if (requestBudget < 1_500) throw new ReconstructionDeadlineError();
        const body: Record<string, unknown> = {
          model: input.arkModel,
          prompt: prompt + (correctionReference ? retryInstruction(input.category) : ""),
          image: correctionReference ? [...inputImages, correctionReference] : inputImages,
          size: input.arkSize,
          response_format: "url",
          sequential_image_generation: "disabled",
          stream: false,
          watermark: false,
        };
        if (supportsArkJpegOutput(input.arkModel)) body.output_format = "jpeg";
        const response = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${requireServerEnv("ARK_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(78_000, requestBudget)),
        });
        const payload = await response.json().catch(() => ({})) as ArkImagePayload;
        return { response, payload };
      }, waitBudget);
      const image = attempt.payload.data?.[0];
      if (!attempt.response.ok || (!image?.b64_json && !image?.url)) {
        const error = arkPayloadError(attempt.payload);
        logServerEvent("warn", "wardrobe_reconstruction_fallback_rejected", {
          provider: "volcengine-seedream",
          model: input.arkModel,
          status: attempt.response.status,
          code: error?.code || "missing_image",
        });
        throw new ProviderRequestError(
          error?.message || error?.code || "火山方舟完整衣物商品图生成失败",
          attempt.response.status === 429 || attempt.response.status >= 500,
          attempt.response.status,
          error?.code || "",
        );
      }

      let rawBytes: Buffer;
      if (image.b64_json) {
        rawBytes = Buffer.from(image.b64_json, "base64");
      } else {
        const downloadBudget = remainingMs();
        if (downloadBudget < 1_000) throw new ReconstructionDeadlineError();
        const generated = await fetch(image.url!, { signal: AbortSignal.timeout(Math.min(10_000, downloadBudget)) });
        if (!generated.ok) {
          throw new ProviderRequestError(
            "火山方舟完整衣物商品图下载失败",
            generated.status === 429 || generated.status >= 500,
            generated.status,
          );
        }
        rawBytes = Buffer.from(await generated.arrayBuffer());
      }

      const quality = await inspectCompleteness(rawBytes, input.category);
      bestCandidate ||= { rawBytes, quality };
      if (quality.completeness !== "pass" || quality.components.status !== "pass") {
        correctionReference = await arkInputDataUrl(rawBytes, 1_536);
        continue;
      }
      return {
        bytes: await normalizeProductImage(rawBytes, quality.components.significantBounds),
        model: input.arkModel,
        provider: "volcengine-seedream" as const,
        providerMs: Math.round(performance.now() - startedAt),
        completeness: quality.completeness,
        componentCount: quality.components.componentCount,
        allowedComponents: quality.components.allowedComponents,
      };
    } catch (error) {
      lastError = error;
      const delayMs = 450;
      if (index === candidateCount - 1 || !isTransientProviderError(error) || remainingMs() < delayMs + 1_500) throw error;
      await retryDelay(delayMs);
    }
  }

  if (!bestCandidate) throw lastError || new Error("火山方舟完整衣物商品图生成失败");
  logServerEvent("warn", "wardrobe_reconstruction_fallback_quality_rejected", {
    model: input.arkModel,
    category: input.category,
    component_count: bestCandidate.quality.components.componentCount,
    allowed_components: bestCandidate.quality.components.allowedComponents,
  });
  throw new Error(bestCandidate.quality.components.status !== "pass"
    ? "生成结果包含分离的衣物部件，请重新生成"
    : "生成结果未完整进入画面，请重新生成");
}

async function requestReconstruction(input: ReconstructionRequest) {
  const startedAt = performance.now();
  const deadlineAt = startedAt + reconstructionDeadlineMs;
  try {
    return await requestAliyunReconstruction(input, deadlineAt);
  } catch (error) {
    if (!isAliyunAccountFailure(error) || !getServerEnv("ARK_API_KEY")) throw error;
    logServerEvent("warn", "wardrobe_reconstruction_provider_fallback", {
      from_provider: "aliyun-bailian",
      to_provider: "volcengine-seedream",
      aliyun_status: error instanceof ProviderRequestError ? error.status : undefined,
      aliyun_code: error instanceof ProviderRequestError ? error.code : "missing_api_key",
      ark_model: input.arkModel,
      ark_size: input.arkSize,
    });
    return requestArkReconstruction(input, deadlineAt);
  }
}

function cacheKey(input: {
  source: Buffer;
  visible?: Buffer;
  category: string;
  color: string;
  description: string;
  model: string;
  size: string;
  candidates: number;
  arkModel: string;
  arkSize: string;
  arkCandidates: number;
}) {
  const hash = createHash("sha256");
  hash.update(PROMPT_VERSION);
  hash.update("\0");
  hash.update(input.model);
  hash.update("\0");
  hash.update(input.size);
  hash.update("\0");
  hash.update(input.arkModel);
  hash.update("\0");
  hash.update(input.arkSize);
  hash.update("\0");
  hash.update(String(input.arkCandidates));
  hash.update("\0");
  hash.update(String(input.candidates));
  hash.update("\0");
  hash.update(input.category);
  hash.update("\0");
  hash.update(input.color);
  hash.update("\0");
  hash.update(input.description);
  hash.update("\0");
  hash.update(input.source);
  if (input.visible) hash.update(input.visible);
  return hash.digest("hex");
}

function storeCache(key: string, result: ReconstructionResult) {
  const existing = resultCache.get(key);
  if (existing) cachedBytes -= existing.bytes.byteLength;
  resultCache.delete(key);
  resultCache.set(key, result);
  cachedBytes += result.bytes.byteLength;
  while (resultCache.size > maxCacheEntries || cachedBytes > maxCacheBytes) {
    const oldestKey = resultCache.keys().next().value;
    if (!oldestKey) break;
    const oldest = resultCache.get(oldestKey);
    resultCache.delete(oldestKey);
    if (oldest) cachedBytes -= oldest.bytes.byteLength;
  }
}

function productResponse(result: ReconstructionResult, cache: "HIT" | "MISS" | "COALESCED", totalMs: number) {
  return new Response(new Uint8Array(result.bytes), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Yida-Output": "ai-reconstructed-complete-garment",
      "X-Yida-Quality": "review",
      "X-Yida-Completeness": result.completeness,
      "X-Yida-Component-Count": String(result.componentCount),
      "X-Yida-Allowed-Components": String(result.allowedComponents),
      "X-Yida-Product-Origin": "ai-reconstructed",
      "X-Layra-Provider": result.provider,
      "X-Layra-Model": result.model,
      "X-Layra-Cache": cache,
      "X-Layra-Latency-Ms": String(totalMs),
      "Server-Timing": `reconstruction;dur=${result.providerMs}`,
    },
  });
}

async function handlePOST(request: Request) {
  const startedAt = performance.now();
  try {
    requireSession(request);
    const form = await request.formData();
    const sourceImage = form.get("sourceImage");
    const visibleImage = form.get("visibleImage");
    if (!(sourceImage instanceof File) || !sourceImage.type.startsWith("image/")) {
      return Response.json({ error: "请上传原始衣物照片" }, { status: 400 });
    }
    if (sourceImage.size > 6 * 1024 * 1024) {
      return Response.json({ error: "原始衣物照片不能超过 6MB" }, { status: 400 });
    }
    if (visibleImage instanceof File && (!visibleImage.type.startsWith("image/") || visibleImage.size > 4 * 1024 * 1024)) {
      return Response.json({ error: "衣物可见部分图片无效" }, { status: 400 });
    }
    const category = normalizedField(form.get("category"), "衣物", 20);
    const color = normalizedField(form.get("color"), "", 20);
    const description = normalizedField(form.get("description"), "", 120);
    const model = getServerEnv("DASHSCOPE_GARMENT_RECONSTRUCTION_MODEL") || DEFAULT_MODEL;
    const configuredSize = getServerEnv("DASHSCOPE_GARMENT_RECONSTRUCTION_SIZE");
    const size = /^\d{3,4}\*\d{3,4}$/.test(configuredSize) || /^(?:1K|2K)$/i.test(configuredSize)
      ? configuredSize
      : DEFAULT_SIZE;
    const configuredCandidateValue = getServerEnv("DASHSCOPE_GARMENT_RECONSTRUCTION_CANDIDATES").trim();
    const configuredCandidates = configuredCandidateValue ? Number(configuredCandidateValue) : Number.NaN;
    const candidates = supportsQwenParameters(model)
      ? Math.max(1, Math.min(2, Number.isInteger(configuredCandidates) ? configuredCandidates : DEFAULT_CANDIDATES))
      : 1;
    const arkModel = getServerEnv("ARK_GARMENT_RECONSTRUCTION_MODEL")
      || getServerEnv("ARK_IMAGE_MODEL")
      || DEFAULT_ARK_MODEL;
    const arkSize = resolveArkReconstructionSize();
    const configuredArkCandidateValue = getServerEnv("ARK_GARMENT_RECONSTRUCTION_CANDIDATES").trim();
    const configuredArkCandidates = configuredArkCandidateValue ? Number(configuredArkCandidateValue) : Number.NaN;
    const arkCandidates = Math.max(
      1,
      Math.min(2, Number.isInteger(configuredArkCandidates) ? configuredArkCandidates : DEFAULT_ARK_CANDIDATES),
    );
    const source = Buffer.from(await sourceImage.arrayBuffer());
    const visible = visibleImage instanceof File ? Buffer.from(await visibleImage.arrayBuffer()) : undefined;
    const input = {
      source,
      visible,
      category,
      color,
      description,
      model,
      size,
      candidates,
      arkModel,
      arkSize,
      arkCandidates,
    };
    const key = cacheKey(input);
    const cached = resultCache.get(key);
    if (cached) {
      resultCache.delete(key);
      resultCache.set(key, cached);
      return productResponse(cached, "HIT", Math.round(performance.now() - startedAt));
    }
    const running = inFlight.get(key);
    if (running) {
      const result = await running;
      return productResponse(result, "COALESCED", Math.round(performance.now() - startedAt));
    }
    const task = requestReconstruction({
      ...input,
      sourceType: sourceImage.type,
      visibleType: visibleImage instanceof File ? visibleImage.type : undefined,
    }).then(result => {
      storeCache(key, result);
      return result;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    const result = await task;
    const totalMs = Math.round(performance.now() - startedAt);
    logServerEvent("info", "wardrobe_reconstruction_completed", {
      model: result.model,
      provider: result.provider,
      provider_ms: result.providerMs,
      total_ms: totalMs,
      completeness: result.completeness,
      component_count: result.componentCount,
      allowed_components: result.allowedComponents,
      cache: "MISS",
    });
    return productResponse(result, "MISS", totalMs);
  } catch (error) {
    const authResponse = responseForAuthError(error);
    if (authResponse) return authResponse;
    return apiErrorResponse(request, error, "完整衣物商品图生成失败");
  }
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "完整衣物商品图生成失败");
}
