import { ApiError, requestJson, requestResponse, wait } from "./api-client";

export type StyleIntensity = "稳妥耐看" | "有点风格" | "大胆一点";
export type OutfitItem = {
  id: string;
  name: string;
  category: string;
  colorName: string;
  season: string;
  style: string;
  imageUrl: string;
};
export type OutfitIntent = {
  occasion: string;
  styles: string[];
  style?: string[];
  warmth: number;
  formality: number;
  colorPreference: string;
  requirements: string[];
  intensity: StyleIntensity;
};
export type OutfitRecommendation = {
  id: string;
  title: string;
  reason: string;
  score: number;
  itemIds: string[];
  items: OutfitItem[];
  highlights: string[];
  scoreBreakdown?: Record<string, number>;
  missingSuggestion?: string;
};
export type TaskMeta = {
  id: string;
  status: "pending" | "running" | "succeeded" | "failed";
  error?: string | null;
  updatedAt?: number;
};
export type RecommendationPayload = {
  recommendations?: OutfitRecommendation[];
  intent?: OutfitIntent | null;
  task?: TaskMeta;
};
export type TaskPhase = "idle" | "submitting" | "running" | "recovering" | "succeeded" | "failed";

export async function buildOutfitReferenceBoard(items: OutfitItem[]) {
  if (!items.length) throw new Error("这套搭配里没有可用的衣柜单品");
  const canvas = document.createElement("canvas");
  const size = 1200;
  const padding = 42;
  const gap = 24;
  const columns = items.length === 1 ? 1 : 2;
  const rows = Math.ceil(items.length / columns);
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法整理搭配参考图，请刷新后重试");
  context.fillStyle = "#f7f7f5";
  context.fillRect(0, 0, size, size);
  const cellWidth = (size - padding * 2 - gap * (columns - 1)) / columns;
  const cellHeight = (size - padding * 2 - gap * (rows - 1)) / rows;

  const bitmaps = await Promise.all(items.map(async item => {
    const response = await fetch(item.imageUrl, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(`无法读取衣柜单品：${item.name}`);
    return createImageBitmap(await response.blob());
  }));

  try {
    bitmaps.forEach((bitmap, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = padding + column * (cellWidth + gap);
      const y = padding + row * (cellHeight + gap);
      context.fillStyle = "#ffffff";
      context.beginPath();
      context.roundRect(x, y, cellWidth, cellHeight, 24);
      context.fill();
      const labelHeight = 54;
      const imagePadding = 22;
      const availableWidth = cellWidth - imagePadding * 2;
      const availableHeight = cellHeight - labelHeight - imagePadding * 2;
      const scale = Math.min(availableWidth / bitmap.width, availableHeight / bitmap.height);
      const drawWidth = bitmap.width * scale;
      const drawHeight = bitmap.height * scale;
      context.drawImage(bitmap, x + (cellWidth - drawWidth) / 2, y + imagePadding + (availableHeight - drawHeight) / 2, drawWidth, drawHeight);
      context.fillStyle = "#303033";
      context.font = "600 25px -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(`${items[index].category} · ${items[index].name}`.slice(0, 22), x + cellWidth / 2, y + cellHeight - labelHeight / 2, cellWidth - 28);
    });
  } finally {
    bitmaps.forEach(bitmap => bitmap.close());
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("搭配参考图整理失败，请重试")), "image/jpeg", 0.92);
  });
}

export async function pollRecommendationTask(taskId: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const { data } = await requestJson<RecommendationPayload>(`/api/outfits/recommend?taskId=${encodeURIComponent(taskId)}`, { timeoutMs: 20_000, signal });
    if (data.task?.status === "failed") throw new Error(data.task.error || "搭配任务失败，请重试");
    if (data.task?.status === "succeeded" || data.recommendations?.length) return data;
    await wait(2_000, signal);
  }
  throw new Error("搭配任务仍在后台处理，稍后刷新页面可继续查看");
}

export async function submitRecommendationTask(taskId: string, input: unknown, signal?: AbortSignal) {
  try {
    const { data } = await requestJson<RecommendationPayload>("/api/outfits/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": taskId },
      body: JSON.stringify(input),
      timeoutMs: 75_000,
      signal,
    });
    if (data.recommendations?.length || data.task?.status === "succeeded") return data;
    return pollRecommendationTask(taskId, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) return pollRecommendationTask(taskId, signal);
    throw error;
  }
}

async function readVisualizationResponse(response: Response) {
  if (response.status === 202 || response.headers.get("Content-Type")?.includes("application/json")) {
    const payload = await response.json() as { task?: TaskMeta };
    if (payload.task?.status === "failed") throw new Error(payload.task.error || "效果图生成失败，请重试");
    return { task: payload.task, blob: null as Blob | null };
  }
  return {
    task: response.headers.get("X-Yida-Task-Id")
      ? { id: response.headers.get("X-Yida-Task-Id")!, status: "succeeded" as const }
      : undefined,
    blob: await response.blob(),
  };
}

export async function pollVisualizationTask(taskId: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await requestResponse(`/api/outfits/visualize?taskId=${encodeURIComponent(taskId)}`, { timeoutMs: 20_000, signal });
    const result = await readVisualizationResponse(response);
    if (result.blob) return result.blob;
    await wait(2_000, signal);
  }
  throw new Error("效果图仍在后台处理，稍后刷新页面可继续查看");
}

export async function submitVisualizationTask(taskId: string, form: FormData, signal?: AbortSignal) {
  try {
    const response = await requestResponse("/api/outfits/visualize", {
      method: "POST",
      headers: { "Idempotency-Key": taskId },
      body: form,
      timeoutMs: 210_000,
      signal,
    });
    const result = await readVisualizationResponse(response);
    if (result.blob) return result.blob;
    return pollVisualizationTask(taskId, signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 0) return pollVisualizationTask(taskId, signal);
    throw error;
  }
}
