import { decodeGarmentTags, normalizeGarmentAITags, type GarmentAITags } from "./garment-tags";
import { requestBlob, requestJson } from "./api-client";
import {
  garmentReconstructionReasons,
  requiresGarmentReconstruction,
  type GarmentDepictionType,
} from "./garment-completeness";

export type GarmentReconstructionOutcome =
  | {
    status: "ready";
    blob: Blob;
    completeness: "pass" | "review";
    model: string;
  }
  | {
    status: "failed";
    error: string;
  };

export type GarmentCompletionStatus = "not-needed" | "generating" | "ready" | "failed";

export type ProcessedGarmentImage = {
  /** Stable across recognition preview, segmentation and AI reconstruction. */
  draftKey: string;
  blob: Blob;
  previewUrl: string;
  originalUrl: string;
  category: string;
  colorName: string;
  colorHex: string;
  season: string;
  style: string;
  name: string;
  cutoutQuality: "good" | "review" | "failed";
  aiTags: GarmentAITags;
  completionStatus: GarmentCompletionStatus;
  productOrigin: "source-preview" | "segmentation" | "ai-reconstructed";
  cutoutProvider?: "comfyui-birefnet" | "aliyun-viapi" | "volcengine-imagex-productv2";
  reconstructionReasons: string[];
  depictionType: GarmentDepictionType;
  visibleRatio: number;
  partiallyOccluded: boolean;
  reconstructionTask?: Promise<GarmentReconstructionOutcome>;
};

type GarmentDetection = {
  id: number;
  category: string;
  color: string;
  bbox_2d: [number, number, number, number];
  partially_occluded: boolean;
  recommended_api: "SegmentCloth" | "SegmentCommodity";
  identity_key?: string;
  source_evidence?: string;
  depiction_type?: "worn" | "product" | "unknown";
  confidence?: number;
  visible_ratio?: number;
  garment_description?: string;
  tags?: GarmentAITags;
};

type RGB = { r: number; g: number; b: number };
type PixelRect = { x: number; y: number; width: number; height: number };
type AtlasClass = "tops" | "pants";
type AtlasMetadata = {
  classes: AtlasClass[];
  foregroundRatios: number[];
  foregroundBounds: PixelRect[];
  sourceWidth: number;
  sourceHeight: number;
};

// Preserve enough pixels for shoes, jewelry and small bags in a full-body shot.
const normalizedImageMaxSide = 1280;
const analysisImageMaxSide = 896;
const productCanvasSize = 1024;
const productCanvasInset = 54;
const uploadProcessingBudgetMs = 34_000;
const minimumFallbackBudgetMs = 1_800;
// ImageX productv2 normally finishes in 4-6 seconds. Keep enough headroom for
// TOS upload and result download while still honoring the sub-10-second UX cap.
const itemProductizeTimeoutMs = 8_800;
const maxClientProductizeRequests = 6;
// Match the bounded server-side image-generation queue. Volcengine Seedream
// can safely process two independent garments in parallel.
// Keeping this bounded at two shortens a full-outfit batch without creating the
// burst of image-generation requests that previously hurt provider reliability.
const maxClientReconstructionRequests = 2;
const atlasClassByCategory = new Map<string, AtlasClass>([
  ["上衣", "tops"],
  ["裤子", "pants"],
]);

const colorPalette: Array<{ name: string; hex: string; rgb: RGB }> = [
  { name: "白色", hex: "#EEEDEA", rgb: { r: 238, g: 237, b: 234 } },
  { name: "奶油色", hex: "#DDD3B8", rgb: { r: 221, g: 211, b: 184 } },
  { name: "浅灰", hex: "#A8A8A5", rgb: { r: 168, g: 168, b: 165 } },
  { name: "黑色", hex: "#252525", rgb: { r: 37, g: 37, b: 37 } },
  { name: "藏青", hex: "#28364D", rgb: { r: 40, g: 54, b: 77 } },
  { name: "蓝色", hex: "#557A9D", rgb: { r: 85, g: 122, b: 157 } },
  { name: "牛仔蓝", hex: "#7998B2", rgb: { r: 121, g: 152, b: 178 } },
  { name: "绿色", hex: "#667B5B", rgb: { r: 102, g: 123, b: 91 } },
  { name: "棕色", hex: "#805C43", rgb: { r: 128, g: 92, b: 67 } },
  { name: "卡其色", hex: "#B59D78", rgb: { r: 181, g: 157, b: 120 } },
  { name: "红色", hex: "#A34343", rgb: { r: 163, g: 67, b: 67 } },
  { name: "酒红", hex: "#713D49", rgb: { r: 113, g: 61, b: 73 } },
  { name: "粉色", hex: "#D69BA9", rgb: { r: 214, g: 155, b: 169 } },
  { name: "紫色", hex: "#786A91", rgb: { r: 120, g: 106, b: 145 } },
  { name: "黄色", hex: "#D2AA4F", rgb: { r: 210, g: 170, b: 79 } },
  { name: "橙色", hex: "#C87841", rgb: { r: 200, g: 120, b: 65 } },
];

function colorDistance(a: RGB, b: RGB) {
  const redMean = (a.r + b.r) / 2;
  const red = a.r - b.r;
  const green = a.g - b.g;
  const blue = a.b - b.b;
  return Math.sqrt((2 + redMean / 256) * red * red + 4 * green * green + (2 + (255 - redMean) / 256) * blue * blue);
}

function nearestColor(rgb: RGB) {
  return colorPalette.reduce((best, color) => colorDistance(rgb, color.rgb) < colorDistance(rgb, best.rgb) ? color : best, colorPalette[0]);
}

function inferCategory(filename: string, width: number, height: number) {
  const value = filename.toLowerCase();
  if (/(pants|trouser|jean|skirt|shorts|裤|裙)/.test(value)) return "下装";
  if (/(shoe|sneaker|boot|loafer|heel|鞋|靴)/.test(value)) return "鞋履";
  if (/(hat|cap|帽)/.test(value)) return "帽子";
  if (/(bag|belt|scarf|watch|necklace|accessory|包|腰带|围巾|配饰)/.test(value)) return "配饰";
  if (/(dress|连衣裙)/.test(value)) return "连衣裙";
  if (width / height > 1.35) return "鞋履";
  return "上衣";
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片处理失败")), "image/png", 0.92));
}

type ProcessingCanvas = HTMLCanvasElement | OffscreenCanvas;
type ProcessingContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createProcessingCanvas(width: number, height: number): ProcessingCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function processingContext(canvas: ProcessingCanvas, options?: CanvasRenderingContext2DSettings) {
  return canvas.getContext("2d", options) as ProcessingContext | null;
}

function canvasToJpegBlob(canvas: ProcessingCanvas, quality = 0.9) {
  if (typeof OffscreenCanvas !== "undefined" && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality });
  }
  const htmlCanvas = canvas as HTMLCanvasElement;
  return new Promise<Blob>((resolve, reject) => htmlCanvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片处理失败")), "image/jpeg", quality));
}

function displayCategory(category: string) {
  if (category === "外套") return "外套";
  if (["裤子", "裙子"].includes(category)) return "下装";
  if (category === "连衣裙") return "连衣裙";
  if (category === "鞋子") return "鞋履";
  if (category === "帽子") return "帽子";
  if (["腰带", "包", "首饰", "其他配饰"].includes(category)) return "配饰";
  return "上衣";
}

function colorForName(name: string) {
  const exact = colorPalette.find(color => name.includes(color.name) || color.name.includes(name));
  if (exact) return exact;
  if (/灰/.test(name)) return colorPalette.find(color => color.name === "浅灰")!;
  if (/白/.test(name)) return colorPalette.find(color => color.name === "白色")!;
  if (/黑/.test(name)) return colorPalette.find(color => color.name === "黑色")!;
  if (/蓝/.test(name)) return colorPalette.find(color => color.name === "蓝色")!;
  if (/绿/.test(name)) return colorPalette.find(color => color.name === "绿色")!;
  if (/棕|咖|焦糖/.test(name)) return colorPalette.find(color => color.name === "棕色")!;
  if (/粉/.test(name)) return colorPalette.find(color => color.name === "粉色")!;
  if (/红/.test(name)) return colorPalette.find(color => color.name === "红色")!;
  return { name: name || "未识别", hex: "#999999", rgb: { r: 153, g: 153, b: 153 } };
}

function createScaledJpegBlobFromBitmap(bitmap: ImageBitmap, maxSide: number, quality: number) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = createProcessingCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  );
  const context = processingContext(canvas);
  if (!context) throw new Error("当前浏览器不支持图片处理");
  // JPEG has no alpha channel. Explicitly composite transparent uploads onto
  // white; otherwise browsers commonly encode transparent pixels as black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvasToJpegBlob(canvas, quality);
}

async function createUploadBlobTasks(file: File) {
  const bitmap = await createImageBitmap(file);
  try {
    // Decode a large phone photo once, then encode the high-quality working
    // copy and compact VLM copy concurrently. The previous pipeline decoded and
    // resampled the image twice before the first network request could start.
    return {
      normalizedBlobPromise: createScaledJpegBlobFromBitmap(bitmap, normalizedImageMaxSide, 0.82),
      analysisBlobPromise: createScaledJpegBlobFromBitmap(bitmap, analysisImageMaxSide, 0.74),
    };
  } finally {
    bitmap.close();
  }
}

function detectionRectForSize(
  width: number,
  height: number,
  box: [number, number, number, number],
  category: string,
): PixelRect {
  const [x1, y1, x2, y2] = box;
  const rawX = x1 / 1000 * width;
  const rawY = y1 / 1000 * height;
  const rawW = Math.max(1, (x2 - x1) / 1000 * width);
  const rawH = Math.max(1, (y2 - y1) / 1000 * height);
  const paddingRate = ["首饰", "其他配饰"].includes(category) ? 0.065 : 0.025;
  const padding = Math.max(rawW, rawH) * paddingRate;
  const sourceX = Math.max(0, Math.floor(rawX - padding));
  const sourceY = Math.max(0, Math.floor(rawY - padding));
  const sourceW = Math.min(width - sourceX, Math.ceil(rawW + padding * 2));
  const sourceH = Math.min(height - sourceY, Math.ceil(rawH + padding * 2));
  return { x: sourceX, y: sourceY, width: sourceW, height: sourceH };
}

function detectionRect(bitmap: ImageBitmap, box: [number, number, number, number], category: string): PixelRect {
  return detectionRectForSize(bitmap.width, bitmap.height, box, category);
}

async function cropDetection(
  bitmap: ImageBitmap,
  box: [number, number, number, number],
  category: string,
  options: { maxSide?: number; quality?: number } = {},
) {
  const source = detectionRect(bitmap, box, category);
  const scale = Math.min(1, (options.maxSide || normalizedImageMaxSide) / Math.max(source.width, source.height));
  const canvas = createProcessingCanvas(
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale)),
  );
  processingContext(canvas)?.drawImage(bitmap, source.x, source.y, source.width, source.height, 0, 0, canvas.width, canvas.height);
  return canvasToJpegBlob(canvas, options.quality ?? 0.9);
}

function foregroundBounds(bitmap: ImageBitmap, region: PixelRect = {
  x: 0,
  y: 0,
  width: bitmap.width,
  height: bitmap.height,
}): (PixelRect & { foregroundRatio: number }) | null {
  const canvas = createProcessingCanvas(region.width, region.height);
  const context = processingContext(canvas, { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(
    bitmap,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  let foreground = 0;
  for (let position = 0; position < canvas.width * canvas.height; position++) {
    const offset = position * 4;
    const whiteDistance = 765 - data[offset] - data[offset + 1] - data[offset + 2];
    if (whiteDistance <= 12) continue;
    const x = position % canvas.width;
    const y = Math.floor(position / canvas.width);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    foreground += 1;
  }
  if (maxX < minX || maxY < minY || foreground < canvas.width * canvas.height * 0.0015) return null;
  const padding = Math.round(Math.max(maxX - minX, maxY - minY) * 0.035);
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  return {
    x: region.x + x,
    y: region.y + y,
    width: Math.min(canvas.width - x, maxX - minX + padding * 2 + 1),
    height: Math.min(canvas.height - y, maxY - minY + padding * 2 + 1),
    foregroundRatio: foreground / Math.max(1, canvas.width * canvas.height),
  };
}

async function renderSegmentedProduct(bitmap: ImageBitmap, source: PixelRect, verifyForeground = true) {
  const canvas = createProcessingCanvas(productCanvasSize, productCanvasSize);
  const context = processingContext(canvas, { willReadFrequently: verifyForeground });
  if (!context) throw new Error("当前浏览器不支持图片处理");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  const available = productCanvasSize - productCanvasInset * 2;
  const scale = Math.min(available / source.width, available / source.height);
  const targetWidth = Math.max(1, Math.round(source.width * scale));
  const targetHeight = Math.max(1, Math.round(source.height * scale));
  const targetX = Math.round((productCanvasSize - targetWidth) / 2);
  const targetY = Math.round((productCanvasSize - targetHeight) / 2);
  context.drawImage(bitmap, source.x, source.y, source.width, source.height, targetX, targetY, targetWidth, targetHeight);

  let foregroundRatio = 1;
  if (verifyForeground) {
    const pixels = context.getImageData(targetX, targetY, targetWidth, targetHeight).data;
    let foregroundSamples = 0;
    let samples = 0;
    for (let offset = 0; offset < pixels.length; offset += 4 * 8) {
      const whiteDistance = 765 - pixels[offset] - pixels[offset + 1] - pixels[offset + 2];
      if (whiteDistance > 12) foregroundSamples += 1;
      samples += 1;
    }
    foregroundRatio = samples ? foregroundSamples / samples : 0;
    if (foregroundRatio < 0.004) return null;
  }
  return { blob: await canvasToJpegBlob(canvas, 0.92), foregroundRatio };
}

async function cropAtlasSegmentation(
  bitmap: ImageBitmap,
  metadata: AtlasMetadata,
  atlasClass: AtlasClass,
  box: [number, number, number, number],
  category: string,
) {
  const panelIndex = metadata.classes.indexOf(atlasClass);
  if (panelIndex < 0) return null;
  const source = detectionRectForSize(metadata.sourceWidth, metadata.sourceHeight, box, category);
  return renderSegmentedProduct(bitmap, {
    ...source,
    x: panelIndex * metadata.sourceWidth + source.x,
  });
}

async function closeBitmapPromise(task: Promise<ImageBitmap | null> | null) {
  if (!task) return;
  try {
    (await task)?.close();
  } catch {
    // Decoding failures are handled by the caller. Cleanup must never mask the
    // original upload error.
  }
}

async function analyzeGarments(image: Blob) {
  const form = new FormData();
  form.append("image", image, "wardrobe-analysis.jpg");
  const { data } = await requestJson<{ detections?: GarmentDetection[] }>("/api/wardrobe/analyze", {
    method: "POST",
    body: form,
    timeoutMs: 22_000,
  });
  if (!data.detections?.length) throw new Error("没有识别到单品");
  return data.detections;
}

const foregroundProductizeWaiters: Array<() => void> = [];
const backgroundProductizeWaiters: Array<() => void> = [];
const reconstructionWaiters: Array<() => void> = [];
let activeProductizeRequests = 0;
let activeReconstructionRequests = 0;

async function withProductizeSlot<T>(task: () => Promise<T>, priority: "foreground" | "background") {
  if (activeProductizeRequests >= maxClientProductizeRequests) {
    await new Promise<void>(resolve => {
      (priority === "foreground" ? foregroundProductizeWaiters : backgroundProductizeWaiters).push(resolve);
    });
  } else {
    activeProductizeRequests += 1;
  }
  try {
    return await task();
  } finally {
    const next = foregroundProductizeWaiters.shift() || backgroundProductizeWaiters.shift();
    if (next) next();
    else activeProductizeRequests -= 1;
  }
}

async function withReconstructionSlot<T>(task: () => Promise<T>) {
  if (activeReconstructionRequests >= maxClientReconstructionRequests) {
    await new Promise<void>(resolve => reconstructionWaiters.push(resolve));
  } else {
    activeReconstructionRequests += 1;
  }
  try {
    return await task();
  } finally {
    const next = reconstructionWaiters.shift();
    if (next) next();
    else activeReconstructionRequests -= 1;
  }
}

function startGarmentReconstruction(
  sourceImage: Blob,
  visibleImage: Blob | null,
  category: string,
  color: string,
  description = "",
): Promise<GarmentReconstructionOutcome> {
  return withReconstructionSlot(async () => {
    const form = new FormData();
    form.append("sourceImage", sourceImage, "source.jpg");
    if (visibleImage) form.append("visibleImage", visibleImage, "visible-garment.jpg");
    form.append("category", category);
    form.append("color", color);
    if (description) form.append("description", description);
    const { data, response } = await requestBlob("/api/wardrobe/reconstruct", {
      method: "POST",
      body: form,
      timeoutMs: 120_000,
    });
    if (response.headers.get("X-Yida-Completeness") !== "pass") {
      throw new Error("完整衣物商品图未通过质量检查");
    }
    return {
      status: "ready" as const,
      blob: data,
      completeness: response.headers.get("X-Yida-Completeness") === "pass" ? "pass" as const : "review" as const,
      model: response.headers.get("X-Layra-Model") || "国内图像编辑模型",
    };
  }).catch(error => ({
    status: "failed" as const,
    error: error instanceof Error ? error.message : "完整衣物商品图生成失败",
  }));
}

async function productizeGarment(
  blob: Blob,
  category: string,
  color: string,
  recommendedApi: GarmentDetection["recommended_api"],
  aiTags: GarmentAITags,
  timeoutMs: number,
  options: {
    preserveGeometry?: boolean;
    atlasClasses?: AtlasClass[];
    combinedAtlas?: boolean;
    partiallyOccluded?: boolean;
    priority?: "foreground" | "background";
  } = {},
) {
  const form = new FormData();
  form.append("image", blob, "garment.jpg");
  form.append("category", category);
  form.append("color", color);
  form.append("recommendedApi", recommendedApi);
  form.append("tags", JSON.stringify(aiTags));
  if (options.preserveGeometry) form.append("preserveGeometry", "true");
  if (options.atlasClasses?.length) form.append("atlasClasses", options.atlasClasses.join(","));
  if (options.combinedAtlas) form.append("combinedAtlas", "true");
  if (options.partiallyOccluded) form.append("partiallyOccluded", "true");
  form.append("deadlineMs", String(Math.max(1_000, timeoutMs - 350)));
  const { data, response } = await withProductizeSlot(
    () => requestBlob("/api/wardrobe/productize", { method: "POST", body: form, timeoutMs }),
    options.priority || "foreground",
  );
  const geometryHeader = response.headers.get("X-Yida-Geometry");
  const atlasClasses = (response.headers.get("X-Yida-Atlas-Classes") || "")
    .split(",")
    .map(value => value.trim())
    .filter((value): value is AtlasClass => value === "tops" || value === "pants");
  const foregroundRatios = (response.headers.get("X-Yida-Atlas-Foreground-Ratios") || "")
    .split(",")
    .map(Number)
    .filter(Number.isFinite);
  const atlasBounds = (response.headers.get("X-Yida-Atlas-Foreground-Bounds") || "")
    .split(";")
    .map(value => value.split(",").map(Number))
    .filter((value): value is [number, number, number, number] => value.length === 4 && value.every(Number.isFinite))
    .map(([x, y, width, height]) => ({ x, y, width, height }));
  const sourceWidth = Number(response.headers.get("X-Yida-Source-Width"));
  const sourceHeight = Number(response.headers.get("X-Yida-Source-Height"));
  const atlas = geometryHeader === "atlas"
    && atlasClasses.length > 0
    && Number.isInteger(sourceWidth)
    && sourceWidth > 0
    && Number.isInteger(sourceHeight)
    && sourceHeight > 0
    ? { classes: atlasClasses, foregroundRatios, foregroundBounds: atlasBounds, sourceWidth, sourceHeight } satisfies AtlasMetadata
    : null;
  return {
    blob: data,
    quality: response.headers.get("X-Yida-Quality") === "good" ? "good" as const : "review" as const,
    aiTags: decodeGarmentTags(response.headers.get("X-Yida-Tags"), { category, color }),
    geometry: geometryHeader === "atlas" ? "atlas" as const : geometryHeader === "source" ? "source" as const : "square-1024" as const,
    atlas,
    provider: response.headers.get("X-Layra-Provider") === "comfyui-birefnet"
      ? "comfyui-birefnet" as const
      : response.headers.get("X-Layra-Provider") === "volcengine-imagex-productv2"
        ? "volcengine-imagex-productv2" as const
        : "aliyun-viapi" as const,
  };
}

function detectionOverlapOfSmaller(a: GarmentDetection, b: GarmentDetection) {
  const [ax1, ay1, ax2, ay2] = a.bbox_2d;
  const [bx1, by1, bx2, by2] = b.bbox_2d;
  const intersection = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) * Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const areaA = Math.max(1, (ax2 - ax1) * (ay2 - ay1));
  const areaB = Math.max(1, (bx2 - bx1) * (by2 - by1));
  return intersection / Math.min(areaA, areaB);
}

function deduplicateBeforeGeneration(detections: GarmentDetection[]) {
  const identityKeys = new Set<string>();
  return [...detections]
    .sort((a, b) => {
      const areaA = (a.bbox_2d[2] - a.bbox_2d[0]) * (a.bbox_2d[3] - a.bbox_2d[1]);
      const areaB = (b.bbox_2d[2] - b.bbox_2d[0]) * (b.bbox_2d[3] - b.bbox_2d[1]);
      return areaB - areaA;
    })
    .filter((item, index, ordered) => {
      const identityKey = String(item.identity_key || "").trim().toLowerCase();
      const semanticKey = identityKey ? `${item.category}|${item.color}|${identityKey}` : "";
      if (semanticKey && identityKeys.has(semanticKey)) return false;
      const overlapsEarlier = ordered.slice(0, index).some(candidate =>
        candidate.category === item.category && detectionOverlapOfSmaller(candidate, item) > 0.68,
      );
      if (overlapsEarlier) return false;
      if (semanticKey) identityKeys.add(semanticKey);
      return true;
    });
}

async function reviewDraftsFromAtlas(
  atlasResult: Awaited<ReturnType<typeof productizeGarment>> | null,
  normalizedBlob: Blob,
  sourceKey = "atlas",
  onlyClasses?: AtlasClass[],
) {
  if (!atlasResult?.atlas || atlasResult.geometry !== "atlas") return [];
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(atlasResult.blob);
    const metadata = atlasResult.atlas;
    if (
      bitmap.width !== metadata.sourceWidth * metadata.classes.length
      || bitmap.height !== metadata.sourceHeight
    ) return [];
    const atlasBitmap = bitmap;
    const candidates = await Promise.all(metadata.classes.map(async (atlasClass, index): Promise<ProcessedGarmentImage | null> => {
      if (onlyClasses && !onlyClasses.includes(atlasClass)) return null;
      const serverRatio = metadata.foregroundRatios[index] || 0;
      if (serverRatio < 0.0015) return null;
      const panel = {
        x: index * metadata.sourceWidth,
        y: 0,
        width: metadata.sourceWidth,
        height: metadata.sourceHeight,
      };
      const serverBounds = metadata.foregroundBounds[index];
      const padding = serverBounds
        ? Math.round(Math.max(serverBounds.width, serverBounds.height) * 0.035)
        : 0;
      const bounds = serverBounds?.width > 0 && serverBounds.height > 0
        ? {
          x: panel.x + Math.max(0, serverBounds.x - padding),
          y: Math.max(0, serverBounds.y - padding),
          width: Math.min(metadata.sourceWidth - Math.max(0, serverBounds.x - padding), serverBounds.width + padding * 2),
          height: Math.min(metadata.sourceHeight - Math.max(0, serverBounds.y - padding), serverBounds.height + padding * 2),
        }
        : foregroundBounds(atlasBitmap, panel);
      if (!bounds) return null;
      const sourceCategory = atlasClass === "tops" ? "上衣" : "裤子";
      const rendered = await renderSegmentedProduct(atlasBitmap, bounds, false);
      if (!rendered) return null;
      const reconstructionTask = startGarmentReconstruction(normalizedBlob, rendered.blob, sourceCategory, "");
      const category = displayCategory(sourceCategory);
      const aiTags = normalizeGarmentAITags(null, {
        category: sourceCategory,
        color: "未识别",
        season: "四季",
        style: "简约",
      });
      const reconstructionReasons = ["单品标签识别未完成，需将可见衣物补全为完整商品图"];
      return {
        draftKey: `${sourceKey}:atlas:${atlasClass}`,
        blob: rendered.blob,
        previewUrl: URL.createObjectURL(rendered.blob),
        originalUrl: URL.createObjectURL(normalizedBlob),
        category,
        colorName: "未识别",
        colorHex: "#999999",
        season: "四季",
        style: "简约",
        name: `待确认${sourceCategory}`,
        cutoutQuality: "review",
        aiTags,
        completionStatus: "generating",
        productOrigin: "segmentation",
        reconstructionReasons,
        depictionType: "unknown",
        visibleRatio: Math.min(1, Math.max(0, serverRatio)),
        partiallyOccluded: true,
        // A partial segmentation can make an image-edit model copy detached
        // fragments. Category + original photo is both faster and more faithful.
        reconstructionTask,
      };
    }));
    return candidates.filter((draft): draft is ProcessedGarmentImage => draft !== null);
  } catch {
    return [];
  } finally {
    bitmap?.close();
  }
}

function failedDetectionDraft(
  normalizedBlob: Blob,
  detection: GarmentDetection,
  draftKey: string,
  reason = "该单品局部图片处理失败，请换一张更清晰的照片重试",
): ProcessedGarmentImage {
  const category = displayCategory(detection.category);
  const color = colorForName(detection.color);
  const depictionType = detection.depiction_type || "unknown";
  const visibleRatio = Number.isFinite(detection.visible_ratio) ? detection.visible_ratio! : 0;
  return {
    draftKey,
    blob: normalizedBlob,
    previewUrl: URL.createObjectURL(normalizedBlob),
    originalUrl: URL.createObjectURL(normalizedBlob),
    category,
    colorName: color.name,
    colorHex: color.hex,
    season: "四季",
    style: "简约",
    name: `${color.name}${detection.category}处理失败`,
    cutoutQuality: "failed",
    aiTags: normalizeGarmentAITags(null, { category: detection.category, color: detection.color, season: "四季", style: "简约" }),
    completionStatus: "failed",
    productOrigin: "source-preview",
    reconstructionReasons: [reason],
    depictionType,
    visibleRatio,
    partiallyOccluded: detection.partially_occluded,
  };
}

function quickFailedDraft(normalizedBlob: Blob, sourceKey = "failed"): ProcessedGarmentImage {
  return {
    draftKey: `${sourceKey}:unresolved`,
    blob: normalizedBlob,
    previewUrl: URL.createObjectURL(normalizedBlob),
    originalUrl: URL.createObjectURL(normalizedBlob),
    category: "待识别",
    colorName: "未识别",
    colorHex: "#999999",
    season: "四季",
    style: "简约",
    name: "整套穿搭识别不完整",
    cutoutQuality: "failed",
    aiTags: normalizeGarmentAITags(null, { category: "服饰", color: "未识别", season: "四季", style: "简约" }),
    completionStatus: "failed",
    productOrigin: "source-preview",
    reconstructionReasons: ["未能完整识别这张照片中的衣服、鞋帽、包和配饰，请换清晰全身照重试"],
    depictionType: "unknown",
    visibleRatio: 0,
    partiallyOccluded: true,
  };
}

export async function processGarmentUpload(
  file: File,
  options: {
    combinedAtlas?: boolean;
    sourceKey?: string;
    onPreview?: (items: ProcessedGarmentImage[]) => void;
  } = {},
): Promise<ProcessedGarmentImage[]> {
  const sourceKey = options.sourceKey || `upload:${file.name}:${file.lastModified}`;
  const processingDeadline = performance.now() + uploadProcessingBudgetMs;
  const { normalizedBlobPromise, analysisBlobPromise } = await createUploadBlobTasks(file);
  const wholeTags = normalizeGarmentAITags(null, { category: "服饰", color: "未识别", season: "四季", style: "简约" });

  // Start both remote paths as soon as their independently encoded input is
  // ready. The 1280px source preserves crop/reconstruction quality, while the
  // compact 896px copy keeps the latency-sensitive wardrobe scan fast.
  const detectionsPromise = analysisBlobPromise.then(analyzeGarments);
  const atlasSegmentationPromise = normalizedBlobPromise.then(normalizedBlob => productizeGarment(
    normalizedBlob,
    "服饰整图",
    "",
    "SegmentCloth",
    wholeTags,
    7_800,
    { atlasClasses: ["tops", "pants"], combinedAtlas: options.combinedAtlas, priority: "background" },
  )).catch(() => null);
  const normalizedBlob = await normalizedBlobPromise;

  let detections: GarmentDetection[];
  try {
    detections = await detectionsPromise;
  } catch {
    // A two-class mask is not proof that the whole outfit was found. Fail
    // closed instead of silently presenting only a top while dropping shoes,
    // hats and bags.
    const failed = quickFailedDraft(normalizedBlob, sourceKey);
    options.onPreview?.([failed]);
    return [failed];
  }

  const uniqueDetections = deduplicateBeforeGeneration(detections);
  if (!uniqueDetections.length) {
    const failed = quickFailedDraft(normalizedBlob, sourceKey);
    options.onPreview?.([failed]);
    return [failed];
  }
  const sourceBitmap = await createImageBitmap(normalizedBlob);
  let atlasBitmapPromise: Promise<ImageBitmap | null> | null = null;
  let atlasMetadata: AtlasMetadata | null = null;
  const getAtlasBitmap = () => {
    if (!atlasBitmapPromise) {
      atlasBitmapPromise = atlasSegmentationPromise.then(async result => {
        if (!result?.atlas || result.geometry !== "atlas") return null;
        const bitmap = await createImageBitmap(result.blob);
        if (
          result.atlas.sourceWidth !== sourceBitmap.width
          || result.atlas.sourceHeight !== sourceBitmap.height
          || bitmap.width !== result.atlas.sourceWidth * result.atlas.classes.length
          || bitmap.height !== result.atlas.sourceHeight
        ) {
          bitmap.close();
          return null;
        }
        atlasMetadata = result.atlas;
        return bitmap;
      }).catch(() => null);
    }
    return atlasBitmapPromise;
  };
  try {
    const discovered = await mapWithConcurrency(uniqueDetections, 6, async (detection, index) => {
      const draftKey = `${sourceKey}:item:${detection.id || index + 1}:${index}`;
      const category = displayCategory(detection.category);
      const color = colorForName(detection.color);
      const depictionType = detection.depiction_type || "unknown";
      const visibleRatio = Number.isFinite(detection.visible_ratio) ? detection.visible_ratio! : 0.7;
      const reconstructionEvidence = {
        category: detection.category,
        bbox: detection.bbox_2d,
        depictionType,
        partiallyOccluded: detection.partially_occluded,
        visibleRatio,
      };
      const reconstructionReasons = garmentReconstructionReasons(reconstructionEvidence);
      const needsReconstruction = requiresGarmentReconstruction(reconstructionEvidence);
      try {
        // Keep a detailed target crop for reconstruction, but publish only a
        // lightweight crop. CSS intentionally softens it until the white-background
        // product image replaces the same stable draftKey.
        const [sourceBlob, previewBlob] = await Promise.all([
          cropDetection(sourceBitmap, detection.bbox_2d, detection.category, { maxSide: 1_024, quality: 0.9 }),
          cropDetection(sourceBitmap, detection.bbox_2d, detection.category, { maxSide: 420, quality: 0.68 }),
        ]);
        const aiTags = normalizeGarmentAITags(detection.tags, { category: detection.category, color: detection.color, season: "四季", style: "简约" });
        const reconstructionTask = needsReconstruction
          ? startGarmentReconstruction(
            normalizedBlob,
            sourceBlob,
            detection.category,
            detection.color,
            detection.garment_description,
          )
          : undefined;
        const draft: ProcessedGarmentImage = {
          draftKey,
          blob: previewBlob,
          previewUrl: URL.createObjectURL(previewBlob),
          originalUrl: URL.createObjectURL(normalizedBlob),
          category,
          colorName: color.name,
          colorHex: color.hex,
          season: "四季",
          style: "简约",
          name: `${color.name}${detection.category}`,
          cutoutQuality: "review",
          aiTags,
          completionStatus: "generating",
          productOrigin: "source-preview",
          reconstructionReasons,
          depictionType,
          visibleRatio,
          partiallyOccluded: detection.partially_occluded,
          reconstructionTask,
        };
        return { detection, draft, sourceBlob, needsReconstruction, preprocessingFailed: false };
      } catch {
        return {
          detection,
          draft: failedDetectionDraft(normalizedBlob, detection, draftKey),
          sourceBlob: null,
          needsReconstruction: false,
          preprocessingFailed: true,
        };
      }
    });

    // Recognition now has a visible result before any remote segmentation or
    // image-generation task finishes. Do not expose the promise on this first
    // callback; the caller registers each job exactly once from the final return.
    options.onPreview?.(discovered.map(({ draft }) => ({ ...draft, reconstructionTask: undefined })));

    const detectedAtlasClasses = new Set<AtlasClass>();
    for (const { detection, preprocessingFailed } of discovered) {
      if (preprocessingFailed) continue;
      if (["上衣", "外套", "连衣裙"].includes(detection.category)) detectedAtlasClasses.add("tops");
      if (["裤子", "裙子", "连衣裙"].includes(detection.category)) detectedAtlasClasses.add("pants");
    }
    const missingAtlasClasses = (["tops", "pants"] as AtlasClass[]).filter(atlasClass => !detectedAtlasClasses.has(atlasClass));
    const supplementalDraftsPromise = missingAtlasClasses.length
      ? atlasSegmentationPromise.then(result => reviewDraftsFromAtlas(result, normalizedBlob, sourceKey, missingAtlasClasses)).then(drafts => {
        if (drafts.length) options.onPreview?.(drafts.map(draft => ({ ...draft, reconstructionTask: undefined })));
        return drafts;
      })
      : Promise.resolve([] as ProcessedGarmentImage[]);

    const refinedDraftsPromise = mapWithConcurrency(discovered, 4, async ({ detection, draft, sourceBlob, needsReconstruction, preprocessingFailed }) => {
      if (preprocessingFailed || !sourceBlob || needsReconstruction) return draft;

      try {
        let blob = sourceBlob;
        let cutoutQuality: ProcessedGarmentImage["cutoutQuality"] = "failed";
        let aiTags = draft.aiTags;
        let cutoutProvider: ProcessedGarmentImage["cutoutProvider"];
        let usedAtlasSegmentation = false;
        const atlasClass = atlasClassByCategory.get(detection.category);

        if (atlasClass) {
          const atlasBitmap = await getAtlasBitmap();
          if (atlasBitmap && atlasMetadata) {
            const generated = await cropAtlasSegmentation(
              atlasBitmap,
              atlasMetadata,
              atlasClass,
              detection.bbox_2d,
              detection.category,
            );
            if (generated) {
              blob = generated.blob;
              const panelIndex = atlasMetadata.classes.indexOf(atlasClass);
              const panelRatio = atlasMetadata.foregroundRatios[panelIndex] || 0;
              const strongForeground = generated.foregroundRatio >= 0.018 && panelRatio >= 0.002;
              cutoutQuality = detection.partially_occluded || !strongForeground ? "review" : "good";
              cutoutProvider = (await atlasSegmentationPromise)?.provider;
              usedAtlasSegmentation = true;
            }
          }
        }

        if (!usedAtlasSegmentation) {
          const fallbackBudget = Math.floor(processingDeadline - performance.now());
          if (fallbackBudget >= minimumFallbackBudgetMs) {
            try {
              const generated = await productizeGarment(
                sourceBlob,
                detection.category,
                detection.color,
                detection.recommended_api,
                aiTags,
                Math.min(itemProductizeTimeoutMs, fallbackBudget),
                { partiallyOccluded: detection.partially_occluded },
              );
              blob = generated.blob;
              cutoutQuality = generated.quality;
              aiTags = generated.aiTags;
              cutoutProvider = generated.provider;
            } catch {
              // 保留原始裁剪图供用户诊断，不会把不可靠的本地抠图自动加入衣柜。
            }
          }
        }

        if (cutoutQuality === "failed") {
          return {
            ...draft,
            blob: sourceBlob,
            cutoutQuality: "failed" as const,
            completionStatus: "failed" as const,
            reconstructionReasons: ["没有生成可靠的完整白底商品图，请换清晰照片重试"],
            reconstructionTask: undefined,
          };
        }

        return {
          ...draft,
          blob,
          previewUrl: URL.createObjectURL(blob),
          cutoutQuality,
          aiTags,
          completionStatus: "not-needed" as const,
          productOrigin: "segmentation" as const,
          cutoutProvider,
          reconstructionTask: undefined,
        } satisfies ProcessedGarmentImage;
      } catch {
        return {
          ...draft,
          blob: sourceBlob,
          cutoutQuality: "failed" as const,
          completionStatus: "failed" as const,
          reconstructionReasons: ["该单品高清图预处理失败，请换清晰照片重试"],
          reconstructionTask: undefined,
        };
      }
    });
    const [results, supplementalDrafts] = await Promise.all([refinedDraftsPromise, supplementalDraftsPromise]);
    const completeSet = [...results, ...supplementalDrafts];
    return completeSet.length ? completeSet : [quickFailedDraft(normalizedBlob, sourceKey)];
  } finally {
    sourceBitmap.close();
    await closeBitmapPromise(atlasBitmapPromise);
  }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  const outcomes = await Promise.allSettled(workers);
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
  if (rejected) throw rejected.reason;
  return results;
}

export async function processGarmentImage(file: File): Promise<ProcessedGarmentImage> {
  const bitmap = await createImageBitmap(file);
  const maxSide = 1400;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error("当前浏览器不支持图片处理");
  }
  try {
    context.drawImage(bitmap, 0, 0, width, height);
  } finally {
    bitmap.close();
  }

  const image = context.getImageData(0, 0, width, height);
  const data = image.data;
  const cornerSize = Math.max(4, Math.round(Math.min(width, height) * 0.045));
  const cornerOrigins = [[0, 0], [width - cornerSize, 0], [0, height - cornerSize], [width - cornerSize, height - cornerSize]];
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let samples = 0;
  for (const [originX, originY] of cornerOrigins) {
    for (let y = originY; y < originY + cornerSize; y += 2) {
      for (let x = originX; x < originX + cornerSize; x += 2) {
        const index = (y * width + x) * 4;
        totalR += data[index]; totalG += data[index + 1]; totalB += data[index + 2]; samples++;
      }
    }
  }
  const background = { r: totalR / samples, g: totalG / samples, b: totalB / samples };
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (position: number) => {
    if (visited[position]) return;
    const offset = position * 4;
    const distance = colorDistance({ r: data[offset], g: data[offset + 1], b: data[offset + 2] }, background);
    if (distance > 105) return;
    visited[position] = 1;
    queue[tail++] = position;
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (head < tail) {
    const position = queue[head++];
    const x = position % width;
    const y = Math.floor(position / width);
    if (x > 0) enqueue(position - 1);
    if (x < width - 1) enqueue(position + 1);
    if (y > 0) enqueue(position - width);
    if (y < height - 1) enqueue(position + width);
  }

  let removed = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let colorR = 0;
  let colorG = 0;
  let colorB = 0;
  let colorSamples = 0;
  for (let position = 0; position < width * height; position++) {
    const offset = position * 4;
    if (visited[position]) {
      const distance = colorDistance({ r: data[offset], g: data[offset + 1], b: data[offset + 2] }, background);
      data[offset + 3] = Math.max(0, Math.min(255, Math.round((distance - 55) * 5.1)));
      if (data[offset + 3] < 20) removed++;
    }
    if (data[offset + 3] > 72) {
      const x = position % width;
      const y = Math.floor(position / width);
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      if (position % 17 === 0) {
        colorR += data[offset]; colorG += data[offset + 1]; colorB += data[offset + 2]; colorSamples++;
      }
    }
  }

  const removedRatio = removed / (width * height);
  const hasSubject = maxX > minX && maxY > minY && removedRatio > 0.03 && removedRatio < 0.92;
  if (!hasSubject) {
    // canvas 仍保留最初 drawImage 的像素；ImageData 只在内存中被修改，
    // 因此无需再次解码图片，也避免遗漏第二个 ImageBitmap。
    minX = 0; minY = 0; maxX = width - 1; maxY = height - 1;
  } else {
    context.putImageData(image, 0, 0);
  }

  const padding = Math.round(Math.max(maxX - minX, maxY - minY) * 0.06);
  const cropX = Math.max(0, minX - padding);
  const cropY = Math.max(0, minY - padding);
  const cropW = Math.min(width - cropX, maxX - minX + padding * 2 + 1);
  const cropH = Math.min(height - cropY, maxY - minY + padding * 2 + 1);
  const output = document.createElement("canvas");
  output.width = cropW;
  output.height = cropH;
  output.getContext("2d")?.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  const blob = await canvasToBlob(output);
  const dominant = nearestColor(colorSamples ? { r: colorR / colorSamples, g: colorG / colorSamples, b: colorB / colorSamples } : { r: 120, g: 120, b: 120 });
  const category = inferCategory(file.name, cropW, cropH);
  const reconstructionReasons = garmentReconstructionReasons({
    category,
    bbox: [0, 0, 1000, 1000],
    depictionType: "unknown",
    partiallyOccluded: !hasSubject,
    visibleRatio: hasSubject ? 0.75 : 0.5,
  });

  return {
    draftKey: `legacy:${file.name}:${file.lastModified}`,
    blob,
    previewUrl: URL.createObjectURL(blob),
    originalUrl: URL.createObjectURL(file),
    category,
    colorName: dominant.name,
    colorHex: dominant.hex,
    season: "四季",
    style: "简约",
    name: `${dominant.name}${category}`,
    cutoutQuality: hasSubject ? "good" : "review",
    aiTags: normalizeGarmentAITags(null, { category, color: dominant.name, season: "四季", style: "简约" }),
    completionStatus: "generating",
    productOrigin: "segmentation",
    reconstructionReasons,
    depictionType: "unknown",
    visibleRatio: hasSubject ? 0.75 : 0.5,
    partiallyOccluded: !hasSubject,
    reconstructionTask: startGarmentReconstruction(file, hasSubject ? blob : null, category, dominant.name),
  };
}
