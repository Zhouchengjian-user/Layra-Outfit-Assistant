import { requireServerEnv, getServerEnv } from "../../../lib/server-env";
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

// Two complementary Qwen passes run in parallel. A slightly wider per-pass
// window is still much faster than serial retries and prevents the client from
// falling back to a clothing-only mask when accessories take longer to name.
const visionDetectionTimeoutMs = 24_000;
const defaultArkBaseUrl = "https://ark.cn-beijing.volces.com/api/v3";
const allowedCategories = new Set(["上衣", "外套", "裤子", "裙子", "连衣裙", "鞋子", "帽子", "腰带", "包", "首饰", "其他配饰"]);

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

function parseJsonContent(content: string) {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("模型未返回单品列表");
  return JSON.parse(stripped.slice(start, end + 1)) as unknown[];
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

function shouldFallbackToArk(error: unknown) {
  if (isProviderBillingFailure(error)) return true;
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
    temperature: 0.1,
    // A full-body photo can legitimately contain 8-12 separate items. Keep
    // enough room for every bbox and description instead of truncating the
    // JSON after the first few garments.
    max_tokens: 1_600,
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: imageData } },
      { type: "text", text: prompt },
    ] }],
  };
  // enable_thinking is a DashScope-compatible extension and is rejected by
  // some OpenAI-compatible providers, so never send it to Volcengine Ark.
  if (provider.name === "dashscope") requestBody.enable_thinking = false;

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
    throw new DetectionProviderError(
      provider.name,
      response.status,
      code,
      typeof message === "string" ? message : "单品识别失败",
    );
  }
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (!content) throw new Error("模型未返回识别结果");
  return cleanDetections(parseJsonContent(content));
}

async function requestDetectionsWithFallback(
  primary: DetectionProviderConfig,
  fallback: DetectionProviderConfig | null,
  imageData: string,
  prompt: string,
  timeoutMs = visionDetectionTimeoutMs,
) {
  const startedAt = performance.now();
  try {
    return await requestDetections(primary, imageData, prompt, timeoutMs);
  } catch (error) {
    const remainingMs = Math.floor(timeoutMs - (performance.now() - startedAt));
    if (!fallback || !shouldFallbackToArk(error) || remainingMs < 2_500) throw error;

    logServerEvent("warn", "wardrobe_detection_provider_fallback", {
      from: primary.name,
      to: fallback.name,
      status: error instanceof DetectionProviderError ? error.status : 0,
      code: error instanceof DetectionProviderError ? error.code : error instanceof Error ? error.name : "unknown",
    });
    try {
      return await requestDetections(fallback, imageData, prompt, remainingMs);
    } catch (fallbackError) {
      logServerEvent("warn", "wardrobe_detection_fallback_failed", {
        provider: fallback.name,
        status: fallbackError instanceof DetectionProviderError ? fallbackError.status : 0,
        code: fallbackError instanceof DetectionProviderError ? fallbackError.code : fallbackError instanceof Error ? fallbackError.name : "unknown",
      });
      // Keep the primary failure so an Arrearage response remains identifiable
      // and is never mistaken for a transient condition worth retrying.
      throw error;
    }
  }
}

function cleanDetections(value: unknown[]) {
  return value.slice(0, 20).flatMap((entry, index): Detection[] => {
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

    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const baseUrl = (getServerEnv("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    const model = getServerEnv("DASHSCOPE_VISION_MODEL") || "qwen3-vl-flash";
    const arkApiKey = getServerEnv("ARK_API_KEY").trim();
    const arkVisionModel = getServerEnv("ARK_VISION_MODEL").trim();
    const primaryProvider: DetectionProviderConfig = { name: "dashscope", baseUrl, apiKey, model };
    // Ark model access is account-specific. An API key alone is insufficient:
    // only enable the fallback when an authorized model/endpoint ID is explicit.
    const arkFallback: DetectionProviderConfig | null = arkApiKey && arkVisionModel ? {
      name: "volcengine-ark",
      apiKey: arkApiKey,
      model: arkVisionModel,
      baseUrl: (getServerEnv("ARK_BASE_URL") || defaultArkBaseUrl).replace(/\/$/, ""),
    } : null;
    const imageData = `data:${image.type};base64,${toBase64(await image.arrayBuffer())}`;
    const jsonRules = `类别只能是：上衣、外套、裤子、裙子、连衣裙、鞋子、帽子、腰带、包、首饰、其他配饰。衬衫、T恤、背心等必须归为上衣；领带、领结、围巾归为其他配饰。上下装必须分开，一双鞋合为一件。裤子与裙子是互斥判断，同一件阔腿裤或裙裤不能再重复输出成裙子。腰带必须是可独立取下的带身与扣头，外套自带系带、衣服装饰带和衬衫打结都不是独立腰带。只输出本图中真实存在、至少能确认品类和颜色的单品；衣服图案、手机、家具和背景物不要输出。拼图中同一单品重复出现时只保留最完整的一处。
bbox_2d 使用 0到1000 的 [xmin,ymin,xmax,ymax]，只框物品本身。即使单品被人体或外套遮挡，只要仍可辨认也要输出，并如实填写 partially_occluded 与 visible_ratio。source_evidence 用10字内说明它在当前图片中的位置；identity_key 用颜色、品类和款式构成，同款重复必须相同。
depiction_type 只能填写 worn、product 或 unknown；穿在人物身上、拿在手里或戴在身上的单品一律填写 worn，独立平铺或白底商品照才填写 product。
garment_description 用50字内准确描述领型、袖型与袖长、衣长、版型、材质、图案或文字、关键口袋和五金，只描述目标单品，不描述人物。尤其要明确上衣是无袖、短袖还是长袖，裤装是否有破洞。
只返回严格 JSON 数组，每项包含 category、color、bbox_2d、partially_occluded、confidence、visible_ratio、is_real_item:true、source_evidence、depiction_type、identity_key、garment_description，不要解释。`;
    const outfitPrompt = `你是服饰入库质检员。按从头到脚的顺序扫描整张图片，识别一套穿搭中每件可单独入柜的真实单品。
逐项检查：帽子；首饰；外套；内搭上衣；腰带；裤子、裙子或连衣裙；手提包或肩背包；左右脚上的一双鞋；其他可穿戴配饰。外套和露出的内搭是两件单品，不能因为重叠漏掉内搭。
${jsonRules}`;
    const detailPrompt = `你是全身穿搭查漏员。重新扫描整张图片，输出所有可单独入柜的真实单品，并重点查找第一次最容易漏掉的小件与画面边缘物品。
必须依次确认头部帽子、颈部领带/领结/围巾、颈手部首饰、腰间独立腰带、肩背或手持包、脚部鞋履，同时也要完整输出上衣、外套和裤裙。不要因为单品较小、被手握住、被身体局部遮挡或靠近图片边缘就省略。
${jsonRules}`;

    // A full-outfit pass and an accessory-focused pass run together. Either
    // successful result is useful, and the merge makes a single slow request
    // incapable of collapsing the response to just a top.
    const scanStartedAt = performance.now();
    const detectionRuns = await Promise.allSettled([
      requestDetectionsWithFallback(primaryProvider, arkFallback, imageData, outfitPrompt),
      requestDetectionsWithFallback(primaryProvider, arkFallback, imageData, detailPrompt),
    ]);
    let general = detectionRuns[0].status === "fulfilled" ? detectionRuns[0].value : [];
    const focusedItems = detectionRuns[1].status === "fulfilled" ? detectionRuns[1].value : [];
    if (!general.length && !focusedItems.length) {
      // The domestic VLM can reject a short burst immediately while a normal
      // inference takes many seconds. Retry one comprehensive pass only for
      // this fast-failure signature; never stack another long request after a
      // genuine model timeout.
      const elapsedMs = performance.now() - scanStartedAt;
      const hasBillingFailure = detectionRuns.some(result => result.status === "rejected" && isProviderBillingFailure(result.reason));
      if (elapsedMs < 2_000 && !hasBillingFailure) {
        await new Promise(resolve => setTimeout(resolve, 700));
        const fallbackBudget = Math.max(3_000, Math.floor(25_500 - elapsedMs - 700));
        try {
          general = await requestDetectionsWithFallback(primaryProvider, arkFallback, imageData, outfitPrompt, fallbackBudget);
        } catch {
          // Preserve the original provider failure below for consistent API errors.
        }
      }
    }
    if (!general.length && !focusedItems.length) {
      const failure = detectionRuns.find((result): result is PromiseRejectedResult => result.status === "rejected");
      throw failure?.reason || new Error("没有识别到可入柜的单品");
    }
    const mergedScans = addMissingFocusedItems(general, focusedItems);
    const spatiallyUnique = deduplicateDetections(deduplicateIdentityGroups(mergedScans));
    const visibleItems = removeItemsHiddenByOuterwear(deduplicateLowerBodyAlternatives(spatiallyUnique));
    const detections = deduplicateIdentityGroups(deduplicateDetections(mergePairs(visibleItems)))
      .map((item, index) => ({ ...item, id: index + 1 }));
    if (!detections.length) throw new Error("没有识别到可入柜的单品");
    return Response.json({ detections });
  } catch (error) {
    const authResponse = responseForAuthError(error);
    if (authResponse) return authResponse;
    return apiErrorResponse(request, error, "单品识别失败");
  }
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "单品识别失败");
}
