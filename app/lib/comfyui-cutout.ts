import "server-only";

import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { getServerEnv } from "./server-env";

type ComfyUpload = {
  name?: string;
  subfolder?: string;
  type?: string;
};

type ComfyPromptResponse = {
  prompt_id?: string;
  node_errors?: Record<string, unknown>;
  error?: { message?: string } | string;
};

type ComfyHistoryImage = {
  filename?: string;
  subfolder?: string;
  type?: string;
};

type ComfyHistory = Record<string, {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<string, { images?: ComfyHistoryImage[] }>;
}>;

export type ComfyCutoutResult = {
  rgba: Buffer;
  providerMs: number;
  model: string;
};

const outputNodeId = "6";
const defaultBaseUrl = "http://127.0.0.1:8188";
const defaultModel = "birefnet.safetensors";
let healthCache: { available: boolean; checkedAt: number } | null = null;

function baseUrl() {
  const configured = getServerEnv("COMFYUI_BASE_URL") || defaultBaseUrl;
  return configured.replace(/\/+$/, "");
}

function requestHeaders(init?: HeadersInit) {
  const headers = new Headers(init);
  const apiKey = getServerEnv("COMFYUI_API_KEY");
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

function configuredTimeoutMs() {
  const value = Number(getServerEnv("COMFYUI_TIMEOUT_MS"));
  return Number.isFinite(value) ? Math.max(2_000, Math.min(30_000, Math.round(value))) : 12_000;
}

async function comfyFetch(path: string, init: RequestInit, timeoutMs: number) {
  return fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: requestHeaders(init.headers),
    signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
  });
}

export function isComfyUiConfigured() {
  return Boolean(getServerEnv("COMFYUI_BASE_URL"));
}

export async function comfyUiAvailable(maxWaitMs = 1_200) {
  if (!isComfyUiConfigured()) return false;
  const now = Date.now();
  if (healthCache && now - healthCache.checkedAt < (healthCache.available ? 5_000 : 15_000)) {
    return healthCache.available;
  }
  try {
    const response = await comfyFetch("/system_stats", { method: "GET" }, maxWaitMs);
    const available = response.ok;
    healthCache = { available, checkedAt: now };
    return available;
  } catch {
    healthCache = { available: false, checkedAt: now };
    return false;
  }
}

function buildBiRefNetPrompt(imageName: string, filenamePrefix: string) {
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: imageName },
    },
    "2": {
      class_type: "LoadBackgroundRemovalModel",
      inputs: { bg_removal_name: getServerEnv("COMFYUI_BIREFNET_MODEL") || defaultModel },
    },
    "3": {
      class_type: "RemoveBackground",
      inputs: { image: ["1", 0], bg_removal_model: ["2", 0] },
    },
    "4": {
      class_type: "InvertMask",
      inputs: { mask: ["3", 0] },
    },
    "5": {
      class_type: "JoinImageWithAlpha",
      inputs: { image: ["1", 0], alpha: ["4", 0] },
    },
    [outputNodeId]: {
      class_type: "SaveImage",
      inputs: { images: ["5", 0], filename_prefix: filenamePrefix },
    },
  };
}

function responseError(payload: ComfyPromptResponse) {
  if (typeof payload.error === "string") return payload.error;
  if (payload.error?.message) return payload.error.message;
  const nodeError = Object.keys(payload.node_errors || {})[0];
  return nodeError ? `节点 ${nodeError} 无法执行` : "ComfyUI 未接受工作流";
}

async function uploadInput(source: Buffer, contentType: string, requestBudgetMs: number) {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const filename = `layra-${digest}.png`;
  const normalized = await sharp(source, { failOn: "none", limitInputPixels: 80_000_000 })
    .rotate()
    .png({ compressionLevel: 6 })
    .toBuffer();
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array(normalized)], { type: contentType || "image/png" }), filename);
  form.append("type", "input");
  form.append("subfolder", "layra");
  form.append("overwrite", "true");
  const response = await comfyFetch("/upload/image", { method: "POST", body: form }, requestBudgetMs);
  if (!response.ok) throw new Error(`ComfyUI 上传失败（${response.status}）`);
  const payload = await response.json() as ComfyUpload;
  if (!payload.name) throw new Error("ComfyUI 未返回上传文件名");
  return [payload.subfolder, payload.name].filter(Boolean).join("/");
}

function historyOutput(payload: ComfyHistory, promptId: string) {
  const entry = payload[promptId];
  const image = entry?.outputs?.[outputNodeId]?.images?.[0];
  if (image?.filename) return image;
  if (entry?.status?.completed || entry?.status?.status_str === "error") {
    throw new Error("ComfyUI 抠图执行失败，请检查节点和模型是否已安装");
  }
  return null;
}

async function waitForOutput(promptId: string, deadlineAt: number) {
  while (Date.now() < deadlineAt) {
    const response = await comfyFetch(`/history/${encodeURIComponent(promptId)}`, { method: "GET" }, Math.min(2_000, deadlineAt - Date.now()));
    if (!response.ok) throw new Error(`ComfyUI 状态查询失败（${response.status}）`);
    const image = historyOutput(await response.json() as ComfyHistory, promptId);
    if (image) return image;
    await new Promise(resolve => setTimeout(resolve, 180));
  }
  throw new Error("ComfyUI 抠图超时，首次加载模型时请稍后重试");
}

async function downloadOutput(image: ComfyHistoryImage, deadlineAt: number) {
  const query = new URLSearchParams({
    filename: image.filename || "",
    subfolder: image.subfolder || "",
    type: image.type || "output",
  });
  const response = await comfyFetch(`/view?${query}`, { method: "GET" }, deadlineAt - Date.now());
  if (!response.ok) throw new Error(`ComfyUI 结果下载失败（${response.status}）`);
  return Buffer.from(await response.arrayBuffer());
}

export async function runComfyUiBiRefNetCutout(
  source: Buffer,
  contentType = "image/jpeg",
  deadlineAt = Date.now() + configuredTimeoutMs(),
): Promise<ComfyCutoutResult> {
  const startedAt = performance.now();
  if (!isComfyUiConfigured()) throw new Error("尚未配置 COMFYUI_BASE_URL");
  if (!(await comfyUiAvailable(Math.min(1_200, deadlineAt - Date.now())))) {
    throw new Error("ComfyUI 服务未启动或无法连接");
  }
  const imageName = await uploadInput(source, contentType, deadlineAt - Date.now());
  const clientId = randomUUID();
  const prompt = buildBiRefNetPrompt(imageName, `layra/cutout/${clientId}`);
  const response = await comfyFetch("/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: clientId }),
  }, deadlineAt - Date.now());
  const payload = await response.json().catch(() => ({})) as ComfyPromptResponse;
  if (!response.ok || !payload.prompt_id) throw new Error(responseError(payload));
  const output = await waitForOutput(payload.prompt_id, deadlineAt);
  const rgba = await downloadOutput(output, deadlineAt);
  return {
    rgba,
    providerMs: Math.round(performance.now() - startedAt),
    model: getServerEnv("COMFYUI_BIREFNET_MODEL") || defaultModel,
  };
}
