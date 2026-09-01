import { getServerEnv } from "../../../lib/server-env";
import { requireSession, responseForAuthError } from "../../../lib/auth";
import { apiErrorResponse, logServerEvent } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";
import { normalizeGarmentAITags, type GarmentAITags } from "../../../lib/garment-tags";

type Detection = {
  id: number;
  category: string;
  color: string;
  bbox_2d: [number, number, number, number];
  partially_occluded: boolean;
  recommended_api: "SegmentCloth" | "SegmentCommodity";
  confidence?: number;
  visible_ratio?: number;
  garment_description?: string;
  identity_key?: string;
  source_evidence?: string;
  depiction_type?: "worn" | "product" | "unknown";
  tags?: GarmentAITags;
};

// Keep the primary scan inside the upload UX budget. The compact tuple schema
// cuts output tokens substantially; a second pass is reserved for the rare
// result that contains only one item.
// Normal Seed 2.1 scans finish in roughly 6-9 seconds. The larger workflow
// budget is used only when the primary returns malformed structured output and
// the secondary domestic VLM needs time to recover the same upload.
const visionDetectionTimeoutMs = 20_000;
const detectionCacheTtlMs = 6 * 60 * 60 * 1_000;
const maxCachedDetections = 40;
const defaultArkBaseUrl = "https://ark.cn-beijing.volces.com/api/v3";
const allowedCategories = new Set(["上衣", "外套", "裤子", "裙子", "连衣裙", "鞋子", "帽子", "腰带", "包", "首饰", "其他配饰"]);

const detectionCache = new Map<string, { detections: Detection[]; expiresAt: number }>();
const detectionProviderCooldowns = new Map<string, number>();

type DetectionProviderConfig = {
  name: "dashscope" | "volcengine-ark";
  baseUrl: string;
  apiKey: string;
  model: string;
};

class DetectionProviderError extends Error {
  constructor(
    readonly provider: DetectionProviderConfig["name"],
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DetectionProviderError";
  }
}

class DetectionOutputError extends Error {
  constructor(message: string, readonly partialDetections: Detection[] = []) {
    super(message);
    this.name = "DetectionOutputError";
  }
}

const colorAliases: Record<string, string> = {
  white: "白色", black: "黑色", grey: "灰色", gray: "灰色", blue: "蓝色",
  navy: "藏青色", green: "绿色", red: "红色", pink: "粉色", purple: "紫色",
  yellow: "黄色", orange: "橙色", brown: "棕色", beige: "米色", khaki: "卡其色",
  silver: "银色", gold: "金色", cream: "奶油色",
};

function normalizeColor(value: unknown) {
  const color = String(value || "未识别").trim().toLowerCase();
  return (colorAliases[color] || color).slice(0, 16);
}

function normalizeIdentityKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{N}-]/gu, "").slice(0, 64);
  if (!key || /^(?:item|object|garment|cloth|单品|衣物)-?\d*$/i.test(key)) return "";
  return key;
}

function mergePairs(items: Detection[]) {
  const consumed = new Set<number>();
  const merged: Detection[] = [];
  for (let index = 0; index < items.length; index++) {
    if (consumed.has(index)) continue;
    const item = items[index];
    if (!["鞋子", "首饰"].includes(item.category)) {
      merged.push(item);
      continue;
    }
    const [x1, y1, x2, y2] = item.bbox_2d;
    const matchIndex = items.findIndex((candidate, candidateIndex) => {
      if (candidateIndex <= index || consumed.has(candidateIndex) || candidate.category !== item.category) return false;
      const [cx1, cy1, cx2, cy2] = candidate.bbox_2d;
      const verticalOverlap = Math.max(0, Math.min(y2, cy2) - Math.max(y1, cy1));
      const minHeight = Math.max(1, Math.min(y2 - y1, cy2 - cy1));
      const maxHeight = Math.max(y2 - y1, cy2 - cy1);
      const centerYDistance = Math.abs((y1 + y2) / 2 - (cy1 + cy2) / 2);
      const horizontalGap = Math.max(0, Math.max(x1, cx1) - Math.min(x2, cx2));
      return horizontalGap < 300 && (verticalOverlap / minHeight > 0.18 || centerYDistance < maxHeight * 0.65);
    });
    if (matchIndex < 0) {
      merged.push(item);
      continue;
    }
    consumed.add(matchIndex);
    const pair = items[matchIndex];
    merged.push({
      ...item,
      bbox_2d: [
        Math.min(item.bbox_2d[0], pair.bbox_2d[0]),
        Math.min(item.bbox_2d[1], pair.bbox_2d[1]),
        Math.max(item.bbox_2d[2], pair.bbox_2d[2]),
        Math.max(item.bbox_2d[3], pair.bbox_2d[3]),
      ],
      partially_occluded: item.partially_occluded || pair.partially_occluded,
    });
  }
  return merged.map((item, index) => ({ ...item, id: index + 1 }));
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function normalizeJsonCandidate(value: string) {
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, '"')
    .replace(/，/g, ",")
    .replace(/：/g, ":")
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/,\s*([wp])\s*(?=[,\]])/g, ',"$1"');
}

function completeCompactEntries(value: string) {
  const entries: unknown[] = [];
  let depth = 0;
  let entryStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "[") {
      depth += 1;
      if (depth === 2) entryStart = index;
      continue;
    }
    if (character !== "]") continue;
    if (depth === 2 && entryStart >= 0) {
      try {
        const entry = JSON.parse(value.slice(entryStart, index + 1)) as unknown;
        if (Array.isArray(entry) && entry.length >= 3 && Array.isArray(entry[2]) && entry[2].length === 4) {
          entries.push(entry);
        }
      } catch {
        // Keep scanning: a later complete tuple may still be independently valid.
      }
      entryStart = -1;
    }
    depth = Math.max(0, depth - 1);
  }
  return entries;
}

function parseJsonContent(content: string) {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) throw new DetectionOutputError("模型未返回单品列表");
  const candidate = stripped.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as unknown[];
  } catch {
    const normalized = normalizeJsonCandidate(candidate);
    try {
      return JSON.parse(normalized) as unknown[];
    } catch {
      // A malformed final tuple should not discard the valid items that came
      // before it. Preserve them while the provider gets one strict repair pass.
      const partialDetections = cleanDetections(completeCompactEntries(normalized));
      throw new DetectionOutputError("模型返回的单品列表格式不完整", partialDetections);
    }
  }
}

function expandCompactDetection(entry: unknown) {
  if (!Array.isArray(entry)) return entry;
  const [category, color, bbox, occluded, evidence, depiction, identity] = entry;
  const identityText = String(identity || "").trim();
  return {
    category,
    color,
    bbox_2d: bbox,
    partially_occluded: occluded === 1 || occluded === true,
    confidence: 0.8,
    visible_ratio: occluded === 1 || occluded === true ? 0.55 : 0.9,
    is_real_item: true,
    source_evidence: evidence,
    depiction_type: depiction === "p" ? "product" : depiction === "w" ? "worn" : "unknown",
    identity_key: identityText,
    garment_description: identityText,
  };
}

function categoryFromSemantics(rawCategory: unknown, semanticText: string) {
  const raw = String(rawCategory || "").trim();
  const text = `${raw} ${semanticText}`;
  if (allowedCategories.has(raw) && raw !== "其他配饰") return raw;
  // Vision models occasionally name a concrete subtype even after being asked
  // for the coarser wardrobe taxonomy (for example, "衬衫" instead of
  // "上衣"). Repair those labels before thresholding and reconstruction so a
  // visible inner shirt is not treated as a tiny accessory.
  if (/领带|领结|围巾|丝巾/i.test(text)) return "其他配饰";
  if (/连衣裙|dress/i.test(text)) return "连衣裙";
  if (/衬衫|T恤|t-shirt|背心|吊带|毛衣|针织衫|卫衣|上衣/i.test(text)) return "上衣";
  if (/西装外套|大衣|风衣|夹克|外套/i.test(text)) return "外套";
  if (/阔腿裤|长裤|短裤|牛仔裤|裤子/i.test(text)) return "裤子";
  if (/半身裙|短裙|长裙|裙子/i.test(text)) return "裙子";
  if (/高跟鞋|运动鞋|休闲鞋|皮鞋|靴|鞋子/i.test(text)) return "鞋子";
  if (/帽子|帽檐|帽顶|帽身/i.test(text)) return "帽子";
  if (/手提包|肩背包|斜挎包|背包|包身/i.test(text)) return "包";
  if (/戒指|项链|耳环|耳钉|手链|胸针|首饰/i.test(text)) return "首饰";
  if (/腰带|皮带|扣带/i.test(text)) return "腰带";
  if (allowedCategories.has(raw)) return raw;
  return "其他配饰";
}

function isAttachedGarmentTie(category: string, semanticText: string) {
  return category === "腰带" && /(?:非独立|外套.{0,8}(?:系带|腰带)|衣(?:服|物).{0,8}系带|装饰带|抽绳|衬衫.{0,8}打结)/.test(semanticText);
}

function isProviderBillingFailure(error: unknown) {
  if (!(error instanceof DetectionProviderError)) return false;
  return /arrearage|insufficient(?:[_\s-]*(?:balance|funds?))?|billing|balance|欠费|余额不足/i.test(`${error.code} ${error.message}`);
}

function detectionProviderKey(provider: DetectionProviderConfig) {
  return `${provider.name}:${provider.model}`;
}

function detectionProviderIsCoolingDown(provider: DetectionProviderConfig) {
  const expiresAt = detectionProviderCooldowns.get(detectionProviderKey(provider)) || 0;
  if (expiresAt > Date.now()) return true;
  detectionProviderCooldowns.delete(detectionProviderKey(provider));
  return false;
}

function coolDownDetectionProvider(provider: DetectionProviderConfig) {
  // Billing/auth failures cannot recover within an upload. Remember them for a
  // short period so subsequent users are not delayed by the same doomed call.
  detectionProviderCooldowns.set(detectionProviderKey(provider), Date.now() + 10 * 60 * 1_000);
}

function shouldFallbackProvider(error: unknown) {
  if (isProviderBillingFailure(error)) return true;
  // A vision request can succeed at the HTTP layer but occasionally return a
  // truncated or malformed JSON array. Treat that as a provider-output failure
  // so the other configured domestic VLM can recover the upload automatically.
  if (error instanceof SyntaxError) return true;
  if (error instanceof DetectionOutputError) return true;
  if (error instanceof DetectionProviderError) {
    if ([401, 403, 408, 409, 425, 429].includes(error.status) || error.status >= 500) return true;
    return /throttl|rate.?limit|quota|service.?unavailable|internal.?error|timeout|temporar/i.test(error.code);
  }
  if (error instanceof TypeError) return true;
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

async function requestDetections(provider: DetectionProviderConfig, imageData: string, prompt: string, timeoutMs = visionDetectionTimeoutMs) {
  const requestBody: Record<string, unknown> = {
    model: provider.model,
    temperature: 0,
    // A compact tuple keeps 8-12 items well below this ceiling. Output-token
    // generation dominated the old two-pass latency, so avoid verbose keys and
    // long descriptions on the latency-sensitive first scan.
    max_tokens: 520,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: imageData } },
      { type: "text", text: prompt },
    ] }],
  };
  // enable_thinking is a DashScope-compatible extension and is rejected by
  // some OpenAI-compatible providers, so never send it to Volcengine Ark.
  if (provider.name === "dashscope") requestBody.enable_thinking = false;
  // Garment localization is a bounded structured-output task, not a reasoning
  // task. Seed 2.1 enables deep thinking by default; disabling it avoids paying
  // for hidden reasoning tokens and keeps upload latency predictable.
  if (provider.name === "volcengine-ark") requestBody.thinking = { type: "disabled" };

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    // The independent class-mask path can still return safe review drafts.
    // Bound the VLM so one slow label request never holds the whole upload UI.
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const providerError = payload.error as Record<string, unknown> | undefined;
    const message = providerError?.message;
    const code = typeof providerError?.code === "string" ? providerError.code : "unknown";
    logServerEvent("warn", "wardrobe_detection_provider_rejected", {
      provider: provider.name,
      model: provider.model,
      status: response.status,
      code,
    });
    const error = new DetectionProviderError(
      provider.name,
      response.status,
      code,
      typeof message === "string" ? message : "单品识别失败",
    );
    if (isProviderBillingFailure(error) || [401, 403].includes(error.status)) coolDownDetectionProvider(provider);
    throw error;
  }
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (!content) throw new Error("模型未返回识别结果");
  const detections = cleanDetections(parseJsonContent(content));
  if (!detections.length) throw new DetectionOutputError("模型未返回可用的单品结果");
  return detections;
}

async function requestDetectionsWithFallback(
  primary: DetectionProviderConfig,
  fallback: DetectionProviderConfig | null,
  imageData: string,
  prompt: string,
  timeoutMs = visionDetectionTimeoutMs,
) {
  const startedAt = performance.now();
  const primaryTimeoutMs = fallback ? Math.min(timeoutMs, 12_000) : timeoutMs;
  try {
    return await requestDetections(primary, imageData, prompt, primaryTimeoutMs);
  } catch (error) {
    let partialDetections = error instanceof DetectionOutputError ? error.partialDetections : [];
    let latestError = error;
    let remainingMs = Math.floor(timeoutMs - (performance.now() - startedAt));

    // Malformed structured output is usually a serialization mistake, not a
    // recognition failure. Give the same domestic model one concise repair
    // attempt before crossing providers, which also avoids dependency on the
    // secondary provider's billing state.
    if ((error instanceof SyntaxError || error instanceof DetectionOutputError) && remainingMs >= 3_500) {
      const repairPrompt = `${prompt}\n格式修复：重新检查整张图并完整输出。必须使用英文半角双引号和逗号，不得有尾逗号、Markdown、注释或省略号；每个单品必须恰好7个字段。`;
      const repairTimeoutMs = fallback ? Math.min(remainingMs - 2_500, 10_000) : remainingMs;
      logServerEvent("warn", "wardrobe_detection_same_provider_repair", {
        provider: primary.name,
        partial_count: partialDetections.length,
      });
      try {
        const repaired = await requestDetections(primary, imageData, repairPrompt, repairTimeoutMs);
        return addMissingFocusedItems(partialDetections, repaired);
      } catch (repairError) {
        latestError = repairError;
        if (repairError instanceof DetectionOutputError && repairError.partialDetections.length) {
          partialDetections = addMissingFocusedItems(partialDetections, repairError.partialDetections);
        }
      }
      remainingMs = Math.floor(timeoutMs - (performance.now() - startedAt));
    }

    if (!fallback || detectionProviderIsCoolingDown(fallback) || !shouldFallbackProvider(latestError) || remainingMs < 2_500) {
      if (partialDetections.length) return partialDetections;
      throw latestError;
    }

    logServerEvent("warn", "wardrobe_detection_provider_fallback", {
      from: primary.name,
      to: fallback.name,
      status: latestError instanceof DetectionProviderError ? latestError.status : 0,
      code: latestError instanceof DetectionProviderError ? latestError.code : latestError instanceof Error ? latestError.name : "unknown",
    });
    try {
      const fallbackDetections = await requestDetections(fallback, imageData, prompt, remainingMs);
      return addMissingFocusedItems(partialDetections, fallbackDetections);
    } catch (fallbackError) {
      if (fallbackError instanceof DetectionOutputError && fallbackError.partialDetections.length) {
        partialDetections = addMissingFocusedItems(partialDetections, fallbackError.partialDetections);
      }
      logServerEvent("warn", "wardrobe_detection_fallback_failed", {
        provider: fallback.name,
        status: fallbackError instanceof DetectionProviderError ? fallbackError.status : 0,
        code: fallbackError instanceof DetectionProviderError ? fallbackError.code : fallbackError instanceof Error ? fallbackError.name : "unknown",
      });
      if (partialDetections.length) return partialDetections;
      throw latestError;
    }
  }
}

function cleanDetections(value: unknown[]) {
  return value.slice(0, 20).flatMap((entry, index): Detection[] => {
    entry = expandCompactDetection(entry);
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const rawBox = Array.isArray(item.bbox_2d) ? item.bbox_2d.map(Number) : [];
    if (rawBox.length !== 4 || rawBox.some(number => !Number.isFinite(number))) return [];
    let [x1, y1, x2, y2] = rawBox;
    x1 = Math.max(0, Math.min(1000, Math.round(x1)));
    y1 = Math.max(0, Math.min(1000, Math.round(y1)));
    x2 = Math.max(0, Math.min(1000, Math.round(x2)));
    y2 = Math.max(0, Math.min(1000, Math.round(y2)));
    if (x2 - x1 < 12 || y2 - y1 < 12) return [];
    const sourceEvidence = String(item.source_evidence || "").trim().slice(0, 80);
    const garmentDescription = String(item.garment_description || "")
      .trim()
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 120);
    const identityKey = normalizeIdentityKey(item.identity_key);
    const semanticText = `${sourceEvidence} ${garmentDescription} ${identityKey}`;
    const category = categoryFromSemantics(item.category, identityKey || sourceEvidence || garmentDescription);
    if (isAttachedGarmentTie(category, semanticText)) return [];
    const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0.74));
    const visibleRatio = Math.max(0, Math.min(1, Number(item.visible_ratio) || 0.7));
    const boxArea = (x2 - x1) * (y2 - y1);
    const jewelry = category === "首饰";
    const smallAccessory = category === "其他配饰";
    const footwear = category === "鞋子";
    const wearableAccessory = ["帽子", "腰带"].includes(category);
    const bag = category === "包";
    // Recall matters for a full outfit: shoes, bags and jewelry are naturally
    // much smaller than tops. Explicit source evidence still guards against
    // background objects, while reconstruction handles partial visibility.
    const minimumConfidence = jewelry ? 0.72 : smallAccessory ? 0.74 : footwear ? 0.5 : wearableAccessory ? 0.52 : bag ? 0.52 : 0.56;
    const minimumVisibleRatio = jewelry ? 0.28 : smallAccessory ? 0.3 : footwear ? 0.28 : wearableAccessory ? 0.25 : bag ? 0.3 : 0.32;
    const minimumBoxArea = jewelry ? 350 : smallAccessory ? 800 : footwear ? 1_800 : wearableAccessory ? 1_000 : bag ? 2_500 : 5_000;
    if (confidence < minimumConfidence || visibleRatio < minimumVisibleRatio || boxArea < minimumBoxArea) return [];
    const depictionType = ["worn", "product"].includes(String(item.depiction_type)) ? String(item.depiction_type) as "worn" | "product" : "unknown";
    // A worn belt must span the waist. A tiny square bbox is almost always a
    // coat knot or buckle fragment; product photos may legitimately show a
    // coiled belt, so the geometry rule does not apply to them.
    if (category === "腰带" && depictionType !== "product" && x2 - x1 < (y2 - y1) * 1.3) return [];
    const commodity = ["鞋子", "帽子", "腰带", "包", "首饰", "其他配饰"].includes(category);
    // A bbox without an explicit pointer back to the current source image is not
    // sufficient evidence. This deliberately favors precision over recall.
    // Chinese location evidence is often naturally two characters (脚部、头顶、手边).
    // Requiring three silently discarded many valid shoes, hats and bags.
    if (item.is_real_item !== true || sourceEvidence.length < 2) return [];
    return [{
      id: Number(item.id) || index + 1,
      category,
      color: normalizeColor(item.color),
      bbox_2d: [x1, y1, x2, y2],
      partially_occluded: Boolean(item.partially_occluded),
      recommended_api: commodity ? "SegmentCommodity" : "SegmentCloth",
      confidence,
      visible_ratio: visibleRatio,
      identity_key: identityKey,
      source_evidence: sourceEvidence,
      garment_description: garmentDescription,
      depiction_type: depictionType,
      tags: normalizeGarmentAITags(item.tags, { category, color: normalizeColor(item.color) }),
    }];
  });
}

async function detectionCacheKey(buffer: ArrayBuffer, provider: DetectionProviderConfig) {
  const prefix = new TextEncoder().encode(`layra-detection-compact-v1\n${provider.name}\n${provider.model}\n`);
  const bytes = new Uint8Array(prefix.length + buffer.byteLength);
  bytes.set(prefix);
  bytes.set(new Uint8Array(buffer), prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function cachedDetections(cacheKey: string) {
  const cached = detectionCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    detectionCache.delete(cacheKey);
    return null;
  }
  detectionCache.delete(cacheKey);
  detectionCache.set(cacheKey, cached);
  return cached.detections;
}

function storeDetections(cacheKey: string, detections: Detection[]) {
  detectionCache.delete(cacheKey);
  detectionCache.set(cacheKey, { detections, expiresAt: Date.now() + detectionCacheTtlMs });
  while (detectionCache.size > maxCachedDetections) {
    const oldestKey = detectionCache.keys().next().value;
    if (!oldestKey) break;
    detectionCache.delete(oldestKey);
  }
}

function detectionResponse(
  detections: Detection[],
  provider: DetectionProviderConfig,
  cacheStatus: "HIT" | "MISS",
  startedAt: number,
) {
  const elapsedMs = Math.round(performance.now() - startedAt);
  return Response.json({ detections }, { headers: {
    "Cache-Control": "private, no-store",
    "X-Yida-Cache": cacheStatus,
    "X-Layra-Provider": provider.name,
    "X-Layra-Model": provider.model,
    "X-Layra-Latency-Ms": String(elapsedMs),
    "Server-Timing": `vision;dur=${elapsedMs}`,
  } });
}

function intersectionRatio(item: Detection, cover: Detection) {
  const [x1, y1, x2, y2] = item.bbox_2d;
  const [cx1, cy1, cx2, cy2] = cover.bbox_2d;
  const intersection = Math.max(0, Math.min(x2, cx2) - Math.max(x1, cx1)) * Math.max(0, Math.min(y2, cy2) - Math.max(y1, cy1));
  return intersection / Math.max(1, (x2 - x1) * (y2 - y1));
}

function removeItemsHiddenByOuterwear(items: Detection[]) {
  const outerwear = items.filter(item => item.category === "外套");
  if (!outerwear.length) return items;
  return items.map(item => {
    if (!["上衣", "裤子", "裙子", "连衣裙"].includes(item.category)) return item;
    const coveredRatio = Math.max(0, ...outerwear.map(cover => intersectionRatio(item, cover)));
    if (coveredRatio < 0.55) return item;
    // Coverage by an outer coat is evidence of occlusion, not evidence that the
    // inner garment does not exist. Preserve the item and route it through the
    // explicit AI-completion review state instead of deleting it.
    return {
      ...item,
      partially_occluded: true,
      visible_ratio: Math.min(item.visible_ratio ?? 0.7, Math.max(0.2, 1 - coveredRatio * 0.65)),
    };
  });
}

function boxIou(a: Detection, b: Detection) {
  const [x1, y1, x2, y2] = a.bbox_2d;
  const [bx1, by1, bx2, by2] = b.bbox_2d;
  const intersection = Math.max(0, Math.min(x2, bx2) - Math.max(x1, bx1)) * Math.max(0, Math.min(y2, by2) - Math.max(y1, by1));
  const union = (x2 - x1) * (y2 - y1) + (bx2 - bx1) * (by2 - by1) - intersection;
  return intersection / Math.max(1, union);
}

function boxArea(item: Detection) {
  const [x1, y1, x2, y2] = item.bbox_2d;
  return Math.max(1, (x2 - x1) * (y2 - y1));
}

function overlapOfSmaller(a: Detection, b: Detection) {
  const [x1, y1, x2, y2] = a.bbox_2d;
  const [bx1, by1, bx2, by2] = b.bbox_2d;
  const intersection = Math.max(0, Math.min(x2, bx2) - Math.max(x1, bx1)) * Math.max(0, Math.min(y2, by2) - Math.max(y1, by1));
  return intersection / Math.min(boxArea(a), boxArea(b));
}

function isSameFootwearObject(a: Detection, b: Detection) {
  return a.category === "鞋子" && b.category === "鞋子" && (boxIou(a, b) > 0.12 || overlapOfSmaller(a, b) > 0.28);
}

function mergeDetectionBoxes(a: Detection, b: Detection): Detection {
  return {
    ...a,
    color: a.color === "未识别" ? b.color : a.color,
    bbox_2d: [
      Math.min(a.bbox_2d[0], b.bbox_2d[0]),
      Math.min(a.bbox_2d[1], b.bbox_2d[1]),
      Math.max(a.bbox_2d[2], b.bbox_2d[2]),
      Math.max(a.bbox_2d[3], b.bbox_2d[3]),
    ],
    partially_occluded: a.partially_occluded || b.partially_occluded,
    confidence: Math.max(a.confidence || 0, b.confidence || 0),
    visible_ratio: Math.max(a.visible_ratio || 0, b.visible_ratio || 0),
  };
}

function deduplicateShoes(items: Detection[]) {
  const shoes = items.filter(item => item.category === "鞋子").sort((a, b) => boxArea(b) - boxArea(a));
  const uniqueShoes: Detection[] = [];
  for (const shoe of shoes) {
    const matchIndex = uniqueShoes.findIndex(candidate => isSameFootwearObject(candidate, shoe));
    if (matchIndex < 0) uniqueShoes.push(shoe);
    else uniqueShoes[matchIndex] = mergeDetectionBoxes(uniqueShoes[matchIndex], shoe);
  }
  return [...items.filter(item => item.category !== "鞋子"), ...uniqueShoes];
}

function deduplicateDetections(items: Detection[]) {
  const ordered = [...items].sort((a, b) => boxArea(b) - boxArea(a));
  const unique: Detection[] = [];
  for (const item of ordered) {
    const matchIndex = unique.findIndex(candidate => {
      if (candidate.category !== item.category) return false;
      const candidateIdentity = normalizeIdentityKey(candidate.identity_key);
      const itemIdentity = normalizeIdentityKey(item.identity_key);
      if (candidateIdentity && itemIdentity && candidateIdentity !== itemIdentity) return false;
      const candidateColor = normalizeColor(candidate.color);
      const itemColor = normalizeColor(item.color);
      if (candidateColor !== "未识别" && itemColor !== "未识别" && candidateColor !== itemColor) return false;
      if (candidateIdentity && candidateIdentity === itemIdentity) {
        return boxIou(candidate, item) > 0.22 || overlapOfSmaller(candidate, item) > 0.56;
      }
      return boxIou(candidate, item) > 0.58 || overlapOfSmaller(candidate, item) > 0.86;
    });
    if (matchIndex < 0) unique.push(item);
    else unique[matchIndex] = mergeDetectionBoxes(unique[matchIndex], item);
  }
  return unique;
}

function detectionQualityScore(item: Detection) {
  const depictionBonus = item.depiction_type === "product" ? 0.32 : item.depiction_type === "worn" ? 0.08 : 0;
  const occlusionPenalty = item.partially_occluded ? 0.22 : 0;
  const sizeScore = Math.min(0.28, Math.sqrt(boxArea(item)) / 1_800);
  return (item.confidence || 0) * 0.28 + (item.visible_ratio || 0) * 0.42 + depictionBonus + sizeScore - occlusionPenalty;
}

function deduplicateLowerBodyAlternatives(items: Detection[]) {
  const lowerBodyCategories = new Set(["裤子", "裙子"]);
  const unique: Detection[] = [];
  for (const item of items) {
    if (!lowerBodyCategories.has(item.category)) {
      unique.push(item);
      continue;
    }
    const conflictIndex = unique.findIndex(candidate =>
      lowerBodyCategories.has(candidate.category)
      && candidate.category !== item.category
      && normalizeColor(candidate.color) === normalizeColor(item.color)
      && overlapOfSmaller(candidate, item) > 0.82,
    );
    if (conflictIndex < 0) unique.push(item);
    else if (detectionQualityScore(item) > detectionQualityScore(unique[conflictIndex])) unique[conflictIndex] = item;
  }
  return unique;
}

/**
 * Collages often show the same garment on a model and again as a product cutout.
 * Geometry cannot dedupe those spatially separated depictions, so the VLM assigns
 * a descriptive identity_key and the server keeps only the clearest evidence.
 */
function deduplicateIdentityGroups(items: Detection[]) {
  const unique: Detection[] = [];
  for (const item of items) {
    const identityKey = normalizeIdentityKey(item.identity_key);
    const groupKey = identityKey ? `${item.category}|${normalizeColor(item.color)}|${identityKey}` : "";
    if (!groupKey) {
      unique.push(item);
      continue;
    }
    const existingIndex = unique.findIndex(candidate => {
      const candidateGroup = `${candidate.category}|${normalizeColor(candidate.color)}|${normalizeIdentityKey(candidate.identity_key)}`;
      if (candidateGroup !== groupKey) return false;
      const sameLocation = boxIou(candidate, item) > 0.2 || overlapOfSmaller(candidate, item) > 0.55;
      const productAndWorn = new Set([candidate.depiction_type, item.depiction_type]).has("product")
        && new Set([candidate.depiction_type, item.depiction_type]).has("worn");
      return sameLocation || productAndWorn;
    });
    if (existingIndex < 0) {
      unique.push(item);
      continue;
    }
    if (detectionQualityScore(item) > detectionQualityScore(unique[existingIndex])) unique[existingIndex] = item;
  }
  return unique;
}

function isSameFocusedAccessory(a: Detection, b: Detection) {
  if (a.category !== b.category) return false;
  return a.category === "鞋子" ? isSameFootwearObject(a, b) : boxIou(a, b) > 0.2 || overlapOfSmaller(a, b) > 0.55;
}

function addMissingFocusedItems(items: Detection[], focusedItems: Detection[]) {
  const merged = [...items];
  for (const focusedItem of focusedItems) {
    const matchIndex = merged.findIndex(item => isSameFocusedAccessory(item, focusedItem));
    if (matchIndex < 0) merged.push(focusedItem);
    else if (detectionQualityScore(focusedItem) > detectionQualityScore(merged[matchIndex])) merged[matchIndex] = focusedItem;
  }
  return deduplicateShoes(merged);
}

async function handlePOST(request: Request) {
  const startedAt = performance.now();
  try {
    requireSession(request);
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      return Response.json({ error: "请上传需要识别的衣物照片" }, { status: 400 });
    }
    if (image.size > 6 * 1024 * 1024) {
      return Response.json({ error: "识别图片不能超过 6MB" }, { status: 400 });
    }

    const dashscopeApiKey = getServerEnv("DASHSCOPE_API_KEY").trim();
    const dashscopeProvider: DetectionProviderConfig | null = dashscopeApiKey ? {
      name: "dashscope",
      apiKey: dashscopeApiKey,
      model: getServerEnv("DASHSCOPE_VISION_MODEL") || "qwen3-vl-flash",
      baseUrl: (getServerEnv("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, ""),
    } : null;
    const arkApiKey = getServerEnv("ARK_API_KEY").trim();
    const arkVisionModel = getServerEnv("ARK_VISION_MODEL").trim();
    // Ark model access is account-specific. An API key alone is insufficient,
    // so only select it when an authorized model ID is explicit.
    const arkProvider: DetectionProviderConfig | null = arkApiKey && arkVisionModel ? {
      name: "volcengine-ark",
      apiKey: arkApiKey,
      model: arkVisionModel,
      baseUrl: (getServerEnv("ARK_BASE_URL") || defaultArkBaseUrl).replace(/\/$/, ""),
    } : null;
    const preferredProvider = getServerEnv("WARDROBE_VISION_PROVIDER").trim().toLowerCase();
    const preferDashScope = preferredProvider === "dashscope";
    const availableDashScope = dashscopeProvider && !detectionProviderIsCoolingDown(dashscopeProvider) ? dashscopeProvider : null;
    const availableArk = arkProvider && !detectionProviderIsCoolingDown(arkProvider) ? arkProvider : null;
    const primaryProvider = preferDashScope
      ? availableDashScope || availableArk
      : availableArk || availableDashScope;
    if (!primaryProvider) {
      throw new Error("服务端缺少 ARK_API_KEY/ARK_VISION_MODEL 或 DASHSCOPE_API_KEY 配置");
    }
    // Both configured domestic VLMs act as a recovery pair. The primary handles
    // normal uploads; the secondary is called only for a provider rejection,
    // timeout, or malformed structured result.
    const fallbackCandidate = primaryProvider.name === "dashscope" ? availableArk : availableDashScope;
    const fallbackProvider = fallbackCandidate && fallbackCandidate.name !== primaryProvider.name ? fallbackCandidate : null;
    const imageBuffer = await image.arrayBuffer();
    const cacheKey = await detectionCacheKey(imageBuffer, primaryProvider);
    const cached = cachedDetections(cacheKey);
    if (cached) return detectionResponse(cached, primaryProvider, "HIT", startedAt);
    const imageData = `data:${image.type};base64,${toBase64(imageBuffer)}`;
    const outfitPrompt = `从头到脚找出图中每件可独立入柜的真实单品。检查帽子、每件首饰、外套、内搭上衣、独立腰带、裤/裙/连衣裙、包、一双鞋、领带领结围巾。外套和内搭分开；一双鞋合一件；衬衫、T恤、背心等必须归为上衣；领带、领结、围巾归为其他配饰。腰带必须是可独立取下的带身与扣头，外套自带系带、衣服装饰带和衬衫打结都不是独立腰带。忽略图案、手机、家具和背景。被人体或外套遮挡但仍可辨认的单品也要输出。
只返回 JSON 数组，无解释。每件严格用数组：[类别,颜色,[xmin,ymin,xmax,ymax],遮挡0或1,位置,d,款式]。坐标0到1000，只框物品本身；位置最多4字；款式最多8字，用颜色品类和款式区分同款重复。类别仅用上衣/外套/裤子/裙子/连衣裙/鞋子/帽子/腰带/包/首饰/其他配饰；d仅用w(穿戴)或p(独立商品图)。`;

    // One compact pass is enough for normal photos. The old pair of concurrent
    // full scans doubled both provider load and JSON output time.
    const scanStartedAt = performance.now();
    let general: Detection[] = [];
    let initialFailure: unknown;
    try {
      general = await requestDetectionsWithFallback(primaryProvider, fallbackProvider, imageData, outfitPrompt);
    } catch (error) {
      initialFailure = error;
      // The domestic VLM can reject a short burst immediately while a normal
      // inference takes several seconds. Retry only this fast-failure signature.
      const elapsedMs = performance.now() - scanStartedAt;
      if (elapsedMs < 2_000 && !isProviderBillingFailure(error)) {
        await new Promise(resolve => setTimeout(resolve, 350));
        const fallbackBudget = Math.max(3_000, Math.floor(15_500 - elapsedMs - 350));
        try {
          general = await requestDetectionsWithFallback(primaryProvider, fallbackProvider, imageData, outfitPrompt, fallbackBudget);
        } catch {
          // Preserve the first provider failure below for consistent API errors.
        }
      }
    }
    if (!general.length) throw initialFailure || new Error("没有识别到可入柜的单品");

    // A one-item answer on a full-outfit upload is the exact failure mode that
    // previously dropped trousers, shoes and bags. Pay for an audit only then.
    let focusedItems: Detection[] = [];
    const auditBudget = Math.floor(16_000 - (performance.now() - scanStartedAt));
    if (general.length === 1 && auditBudget >= 3_000) {
      try {
        focusedItems = await requestDetectionsWithFallback(primaryProvider, fallbackProvider, imageData, outfitPrompt, auditBudget);
      } catch {
        // The first valid item remains useful as a review draft.
      }
    }
    const mergedScans = addMissingFocusedItems(general, focusedItems);
    const spatiallyUnique = deduplicateDetections(deduplicateIdentityGroups(mergedScans));
    const visibleItems = removeItemsHiddenByOuterwear(deduplicateLowerBodyAlternatives(spatiallyUnique));
    const detections = deduplicateIdentityGroups(deduplicateDetections(mergePairs(visibleItems)))
      .map((item, index) => ({ ...item, id: index + 1 }));
    if (!detections.length) throw new Error("没有识别到可入柜的单品");
    storeDetections(cacheKey, detections);
    return detectionResponse(detections, primaryProvider, "MISS", startedAt);
  } catch (error) {
    const authResponse = responseForAuthError(error);
    if (authResponse) return authResponse;
    return apiErrorResponse(request, error, "单品识别失败");
  }
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "单品识别失败");
}
