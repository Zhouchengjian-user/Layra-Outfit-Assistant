import { decodeGarmentTags, normalizeGarmentAITags, type GarmentAITags } from "./garment-tags";

export type ProcessedGarmentImage = {
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
};

type GarmentDetection = {
  id: number;
  category: string;
  color: string;
  bbox_2d: [number, number, number, number];
  partially_occluded: boolean;
  recommended_api: "SegmentCloth" | "SegmentCommodity";
};

type RGB = { r: number; g: number; b: number };

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

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality = 0.9) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片处理失败")), "image/jpeg", quality));
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

async function createAnalysisBlob(file: File) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasToJpegBlob(canvas, 0.86);
}

async function cropDetection(file: File, box: [number, number, number, number], category: string) {
  const bitmap = await createImageBitmap(file);
  const [x1, y1, x2, y2] = box;
  const rawX = x1 / 1000 * bitmap.width;
  const rawY = y1 / 1000 * bitmap.height;
  const rawW = Math.max(1, (x2 - x1) / 1000 * bitmap.width);
  const rawH = Math.max(1, (y2 - y1) / 1000 * bitmap.height);
  const paddingRate = ["首饰", "其他配饰"].includes(category) ? 0.065 : 0.025;
  const padding = Math.max(rawW, rawH) * paddingRate;
  const sourceX = Math.max(0, Math.floor(rawX - padding));
  const sourceY = Math.max(0, Math.floor(rawY - padding));
  const sourceW = Math.min(bitmap.width - sourceX, Math.ceil(rawW + padding * 2));
  const sourceH = Math.min(bitmap.height - sourceY, Math.ceil(rawH + padding * 2));
  const scale = Math.min(1, 1600 / Math.max(sourceW, sourceH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceW * scale));
  canvas.height = Math.max(1, Math.round(sourceH * scale));
  canvas.getContext("2d")?.drawImage(bitmap, sourceX, sourceY, sourceW, sourceH, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvasToJpegBlob(canvas, 0.9);
}

async function analyzeGarments(file: File) {
  const form = new FormData();
  form.append("image", await createAnalysisBlob(file), "wardrobe-analysis.jpg");
  const response = await fetch("/api/wardrobe/analyze", { method: "POST", body: form });
  const payload = await response.json() as { detections?: GarmentDetection[]; error?: string };
  if (!response.ok || !payload.detections?.length) throw new Error(payload.error || "没有识别到单品");
  return payload.detections;
}

async function productizeGarment(blob: Blob, category: string, color: string) {
  const form = new FormData();
  form.append("image", blob, "garment.jpg");
  form.append("category", category);
  form.append("color", color);
  const response = await fetch("/api/wardrobe/productize", { method: "POST", body: form });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || "高清商品图生成失败");
  }
  return {
    blob: await response.blob(),
    quality: response.headers.get("X-Yida-Quality") === "good" ? "good" as const : "review" as const,
    aiTags: decodeGarmentTags(response.headers.get("X-Yida-Tags"), { category, color }),
  };
}

export async function processGarmentUpload(file: File): Promise<ProcessedGarmentImage[]> {
  let detections: GarmentDetection[];
  try {
    detections = await analyzeGarments(file);
  } catch {
    const fallback = await processGarmentImage(file);
    return [{ ...fallback, cutoutQuality: "failed" }];
  }

  const results = await mapWithConcurrency(detections, 2, async detection => {
    const sourceBlob = await cropDetection(file, detection.bbox_2d, detection.category);
    const category = displayCategory(detection.category);
    const color = colorForName(detection.color);
    let blob = sourceBlob;
    let cutoutQuality: ProcessedGarmentImage["cutoutQuality"] = "failed";
    let aiTags = normalizeGarmentAITags(null, { category: detection.category, color: detection.color, season: "四季", style: "简约" });
    try {
      const generated = await productizeGarment(sourceBlob, detection.category, detection.color);
      blob = generated.blob;
      cutoutQuality = generated.quality;
      aiTags = generated.aiTags;
    } catch {
      // Keep the source crop only as a diagnostic preview. Failed items are not selected for saving.
    }
    return {
      blob,
      previewUrl: URL.createObjectURL(blob),
      originalUrl: URL.createObjectURL(sourceBlob),
      category,
      colorName: color.name,
      colorHex: color.hex,
      season: "四季",
      style: "简约",
      name: `${color.name}${detection.category}`,
      cutoutQuality,
      aiTags,
    } satisfies ProcessedGarmentImage;
  });
  return results.length ? results : [await processGarmentImage(file)];
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
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
  if (!context) throw new Error("当前浏览器不支持图片处理");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

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
    context.drawImage(await createImageBitmap(file), 0, 0, width, height);
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

  return {
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
  };
}
