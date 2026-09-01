import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { getOwner, ownerJson } from "../../../lib/owner";
import { dbAll, dbRun, ensureSchema } from "../../../lib/db";
import { storageDelete, storageGet, storagePut } from "../../../lib/storage";
import { starterGarmentsFor, type StarterGarment } from "../../../lib/starter-wardrobe";
import { apiErrorResponse, logServerEvent } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";
import sharp from "sharp";

/**
 * 预设衣柜：服务端按性别生成/复用真实商品图，一次生成全局缓存，
 * 之后任何用户秒级入库（图片与标签都真实，可编辑、可参与推荐与试穿）。
 */

type ItemRow = { id: string; name: string; imageKey: string; aiTags: string };

type ProductImage = { buffer: Buffer; contentType: string };

type DashScopeImagePayload = {
  output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
  message?: string;
  code?: string;
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

const DEFAULT_ARK_PRODUCT_IMAGE_MODEL = "doubao-seedream-5-0-lite-260128";
const DEFAULT_ARK_PRODUCT_IMAGE_SIZE = "1920x1920";
const MIN_SAFE_ARK_PIXELS = 2_560 * 1_440;
const MAX_SAFE_ARK_PIXELS = 4_096 * 4_096;
const MAX_PRODUCT_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PRODUCT_IMAGE_PIXELS = 40_000_000;
const inFlightProductImages = new Map<string, Promise<ProductImage>>();

class ProductImageProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code = "",
  ) {
    super(message);
    this.name = "ProductImageProviderError";
  }
}

function parseItemTags(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function deleteStarterRow(ownerId: string, row: ItemRow, protectedImageKeys = new Set<string>()) {
  await dbRun("DELETE FROM wardrobe_items WHERE id = ? AND owner_id = ?", [row.id, ownerId]);
  if (row.imageKey && !protectedImageKeys.has(row.imageKey)) {
    await storageDelete(row.imageKey).catch(() => undefined);
  }
}

/**
 * 将已有预设记录映射回当前目录。新记录优先使用 starterId，旧记录按名称兼容；
 * 重复或已退出目录的预设会清理，只处理目标 starterGender，不触碰用户同名衣物。
 */
async function reconcileStarterCatalog(ownerId: string, gender: "女" | "男", items: StarterGarment[]) {
  const marker = `%"starterGender":"${gender}"%`;
  const rows = await dbAll<ItemRow>(
    "SELECT id, name, image_key AS imageKey, ai_tags AS aiTags FROM wardrobe_items WHERE owner_id = ? AND ai_tags LIKE ? ORDER BY created_at ASC, id ASC",
    [ownerId, marker],
  );
  const catalogById = new Map(items.map(item => [item.id, item]));
  const catalogByName = new Map(items.map(item => [item.name, item]));
  const matched = new Map<string, { row: ItemRow; hasStableId: boolean }>();
  const duplicates: ItemRow[] = [];
  const stale: ItemRow[] = [];

  for (const row of rows) {
    const tags = parseItemTags(row.aiTags);
    if (tags.starterGender !== gender) continue;
    const starterId = typeof tags.starterId === "string" ? tags.starterId : "";
    const catalogItem = catalogById.get(starterId) || catalogByName.get(row.name);
    if (!catalogItem) {
      stale.push(row);
      continue;
    }

    const candidate = { row, hasStableId: starterId === catalogItem.id };
    const current = matched.get(catalogItem.id);
    if (!current) {
      matched.set(catalogItem.id, candidate);
      continue;
    }
    if (!current.hasStableId && candidate.hasStableId) {
      duplicates.push(current.row);
      matched.set(catalogItem.id, candidate);
    } else {
      duplicates.push(row);
    }
  }

  const protectedImageKeys = new Set([...matched.values()].map(({ row }) => row.imageKey).filter(Boolean));
  for (const obsolete of [...duplicates, ...stale]) {
    await deleteStarterRow(ownerId, obsolete, protectedImageKeys);
  }
  return matched;
}

/** 删除某个性别（或全部）的预设单品，保留用户自己上传的衣物。 */
async function removeStarterItems(ownerId: string, gender: "女" | "男" | "all") {
  const marker = gender === "all" ? "%starterGender%" : `%"starterGender":"${gender}"%`;
  const rows = await dbAll<ItemRow>(
    "SELECT id, name, image_key AS imageKey, ai_tags AS aiTags FROM wardrobe_items WHERE owner_id = ? AND ai_tags LIKE ?",
    [ownerId, marker],
  );
  for (const row of rows) {
    await deleteStarterRow(ownerId, row);
  }
  return rows.length;
}

function productImagePrompt(drawPrompt: string) {
  return `一张真实服装摄影风格的电商白底商品图，单品：${drawPrompt}。
要求：单品完整居中平铺展示，纯白色干净背景，柔和均匀光影，真实材质纹理，高清细节，无人物、无模特、无假人、无手、无衣架、无文字、无水印、无边框，仅一件单品，正面视角，简洁高级。`;
}

function resolveArkProductImageSize() {
  const configured = getServerEnv("ARK_PRODUCT_IMAGE_SIZE");
  if (!configured) return DEFAULT_ARK_PRODUCT_IMAGE_SIZE;
  const preset = configured.toUpperCase();
  if (["2K", "3K", "4K"].includes(preset)) return preset;
  const match = /^(\d{3,4})x(\d{3,4})$/i.exec(configured);
  if (!match) return DEFAULT_ARK_PRODUCT_IMAGE_SIZE;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width / height, height / width);
  return pixels >= MIN_SAFE_ARK_PIXELS && pixels <= MAX_SAFE_ARK_PIXELS && ratio <= 16
    ? `${width}x${height}`
    : DEFAULT_ARK_PRODUCT_IMAGE_SIZE;
}

function supportsArkJpegOutput(model: string) {
  return /seedream-5-0-(?:pro|lite)(?:-|$)/i.test(model);
}

function arkPayloadError(payload: ArkImagePayload) {
  const nested = payload.data?.find(item => item.error)?.error;
  return payload.error || nested;
}

function providerFailureFields(error: unknown) {
  if (error instanceof ProductImageProviderError) {
    return { status: error.status || 0, code: error.code || "provider_error" };
  }
  if (error instanceof Error && /DASHSCOPE_API_KEY|ARK_API_KEY/.test(error.message)) {
    return { status: 0, code: "missing_api_key" };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return { status: 0, code: "timeout" };
  if (error instanceof TypeError) return { status: 0, code: "network_error" };
  return { status: 0, code: "unexpected_error" };
}

async function validateProductImage(input: Buffer | Uint8Array): Promise<ProductImage> {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!buffer.byteLength || buffer.byteLength > MAX_PRODUCT_IMAGE_BYTES) {
    throw new ProductImageProviderError("预设商品图数据无效", undefined, "invalid_image_size");
  }
  try {
    const decoder = sharp(buffer, { failOn: "error", limitInputPixels: MAX_PRODUCT_IMAGE_PIXELS });
    const metadata = await decoder.metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    const contentTypes: Record<string, string> = {
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
    };
    const contentType = metadata.format ? contentTypes[metadata.format] : "";
    if (!contentType || width < 128 || height < 128 || width * height > MAX_PRODUCT_IMAGE_PIXELS) {
      throw new Error("unsupported image");
    }
    // metadata 只校验头部；再解码一个像素，防止截断或伪造图片污染全局缓存。
    await decoder.clone().resize(1, 1, { fit: "fill" }).raw().toBuffer();
    return { buffer, contentType };
  } catch (error) {
    if (error instanceof ProductImageProviderError) throw error;
    throw new ProductImageProviderError("预设商品图解码失败", undefined, "invalid_image");
  }
}

async function fetchProductImageUrl(url: string, timeoutMs = 12_000): Promise<ProductImage> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProductImageProviderError("预设商品图地址无效", undefined, "invalid_image_url");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new ProductImageProviderError("预设商品图地址无效", undefined, "unsafe_image_url");
  }
  const response = await fetch(parsedUrl, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new ProductImageProviderError("预设商品图下载失败", response.status, "image_download_failed");
  }
  const contentLength = Number(response.headers.get("Content-Length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_PRODUCT_IMAGE_BYTES) {
    throw new ProductImageProviderError("预设商品图过大", response.status, "image_too_large");
  }
  return validateProductImage(Buffer.from(await response.arrayBuffer()));
}

/** 压缩成 512×512 JPEG（白底填充），供衣柜展示与推荐使用，避免大图加载慢/裂图。 */
async function compressForWardrobe(buffer: ArrayBuffer | Uint8Array): Promise<Buffer> {
  return sharp(buffer, { failOn: "error", limitInputPixels: MAX_PRODUCT_IMAGE_PIXELS })
    .resize(512, 512, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 84 })
    .toBuffer();
}

async function requestDashScopeProductImage(prompt: string): Promise<ProductImage> {
  const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
  const endpoint = getServerEnv("DASHSCOPE_IMAGE_ENDPOINT") || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const model = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_MODEL") || "qwen-image-2.0";
  const size = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_SIZE") || "1024*1024";
  const response = await fetch(endpoint, {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { n: 1, negative_prompt: "人物，模特，人体，假人，皮肤，手，手指，衣架，背景，家具，杂物，道具，文字，水印，边框，多件，重复", prompt_extend: false, watermark: false, size },
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({})) as DashScopeImagePayload;
  const imageUrl = payload.output?.choices?.[0]?.message?.content?.find(item => item.image)?.image || "";
  if (!response.ok || !imageUrl) {
    throw new ProductImageProviderError(
      "百炼预设商品图生成失败",
      response.status,
      payload.code || (imageUrl ? "provider_rejected" : "missing_image"),
    );
  }
  return fetchProductImageUrl(imageUrl);
}

async function requestArkProductImage(prompt: string): Promise<ProductImage> {
  const model = getServerEnv("ARK_PRODUCT_IMAGE_MODEL")
    || getServerEnv("ARK_IMAGE_MODEL")
    || DEFAULT_ARK_PRODUCT_IMAGE_MODEL;
  const size = resolveArkProductImageSize();
  const baseUrl = getServerEnv("ARK_BASE_URL") || "https://ark.cn-beijing.volces.com/api/v3";
  const body: Record<string, unknown> = {
    model,
    prompt,
    size,
    response_format: "url",
    sequential_image_generation: "disabled",
    stream: false,
    watermark: false,
  };
  if (supportsArkJpegOutput(model)) body.output_format = "jpeg";
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/images/generations`, {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${requireServerEnv("ARK_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const payload = await response.json().catch(() => ({})) as ArkImagePayload;
  const image = payload.data?.find(item => item.b64_json || item.url);
  if (!response.ok || (!image?.b64_json && !image?.url)) {
    const error = arkPayloadError(payload);
    throw new ProductImageProviderError(
      "火山方舟预设商品图生成失败",
      response.status,
      error?.code || (image ? "provider_rejected" : "missing_image"),
    );
  }
  if (image.b64_json) return validateProductImage(Buffer.from(image.b64_json, "base64"));
  return fetchProductImageUrl(image.url!);
}

let dashScopeUnavailableUntil = 0;
const DASH_SCOPE_FAILURE_COOLDOWN_MS = 60_000;

async function arkProductImageWithSafeLog(prompt: string) {
  try {
    return await requestArkProductImage(prompt);
  } catch (error) {
    logServerEvent("warn", "starter_product_ark_rejected", providerFailureFields(error));
    throw error;
  }
}

async function generateProductImage(drawPrompt: string): Promise<ProductImage> {
  const prompt = productImagePrompt(drawPrompt);
  const arkConfigured = Boolean(getServerEnv("ARK_API_KEY"));
  if (arkConfigured && Date.now() < dashScopeUnavailableUntil) {
    return arkProductImageWithSafeLog(prompt);
  }
  try {
    return await requestDashScopeProductImage(prompt);
  } catch (error) {
    if (!arkConfigured) throw error;
    dashScopeUnavailableUntil = Date.now() + DASH_SCOPE_FAILURE_COOLDOWN_MS;
    logServerEvent("warn", "starter_product_provider_fallback", providerFailureFields(error));
    return arkProductImageWithSafeLog(prompt);
  }
}

function fileErrorCode(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "seed_read_failed";
}

async function staticStarterImage(gender: StarterGarment["gender"], garmentId: string): Promise<ProductImage | null> {
  if (!/^[a-z0-9-]+$/.test(garmentId) || !garmentId.startsWith(`${gender}-`)) {
    throw new Error("预设衣柜单品 ID 无效");
  }
  const seedPath = join(process.cwd(), "public", "starter-wardrobe", gender, `${garmentId}.webp`);
  let bytes: Buffer;
  try {
    bytes = await readFile(seedPath);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    logServerEvent("warn", "starter_product_seed_rejected", { status: 0, code: fileErrorCode(error) });
    return null;
  }
  try {
    return await validateProductImage(bytes);
  } catch (error) {
    logServerEvent("warn", "starter_product_seed_rejected", providerFailureFields(error));
    return null;
  }
}

function starterGenderFromId(garmentId: string): StarterGarment["gender"] {
  if (garmentId.startsWith("female-")) return "female";
  if (garmentId.startsWith("male-")) return "male";
  throw new Error("预设衣柜单品 ID 缺少性别前缀");
}

/** 静态种子图优先，其次是全局缓存；两者都没有时才调用国内生图服务。 */
async function cachedProductImage(garmentId: string, drawPrompt: string) {
  const gender = starterGenderFromId(garmentId);
  const seeded = await staticStarterImage(gender, garmentId);
  if (seeded) return seeded;

  const cacheKey = `starter-products/${garmentId}.image`;
  const cached = await storageGet(cacheKey);
  if (cached) {
    try {
      return await validateProductImage(cached.body);
    } catch (error) {
      logServerEvent("warn", "starter_product_cache_rejected", providerFailureFields(error));
      await storageDelete(cacheKey).catch(() => undefined);
    }
  }

  const running = inFlightProductImages.get(cacheKey);
  if (running) return running;
  const generation = generateProductImage(drawPrompt)
    .then(async generated => {
      // generateProductImage 返回前已完成解码校验，不会将坏图写入全局缓存。
      await storagePut(cacheKey, generated.buffer, generated.contentType).catch(() => undefined);
      return generated;
    })
    .finally(() => inFlightProductImages.delete(cacheKey));
  inFlightProductImages.set(cacheKey, generation);
  return generation;
}

async function handleDELETE(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const gender = url.searchParams.get("gender");
    if (gender !== "男" && gender !== "女" && gender !== "all") {
      return ownerJson({ error: "缺少性别参数" }, owner, 400);
    }
    const removed = await removeStarterItems(owner.id, gender);
    return ownerJson({ removed, ok: true }, owner);
  } catch (error) {
    return apiErrorResponse(request, error, "移除预设衣柜失败");
  }
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const body = await request.json().catch(() => ({})) as { gender?: string };
    const gender = body.gender === "男" ? "男" : "女";
    const items = starterGarmentsFor(gender);
    const existing = await reconcileStarterCatalog(owner.id, gender, items);
    const missingItems = items.filter(item => !existing.has(item.id));
    const created: Array<{ id: string; name: string; category: string; colorName: string; colorHex: string; season: string; style: string; aiTags: Record<string, unknown> }> = [];
    const errors: string[] = [];
    // 串行入库；图片优先读静态种子与全局缓存，缺图才走供应商降级链。
    for (const garment of missingItems) {
      let imageKey = "";
      try {
        const { buffer } = await cachedProductImage(garment.id, garment.drawPrompt);
        const id = crypto.randomUUID();
        // 入库用压缩图（512 JPEG 约 20-40KB），原图保留在全局缓存
        const compressed = await compressForWardrobe(buffer);
        imageKey = `${owner.id}/${id}.jpg`;
        const createdAt = Date.now();
        const aiTags = { ...garment.aiTags, starterGender: gender, starterId: garment.id };
        await storagePut(imageKey, compressed, "image/jpeg");
        await dbRun(`INSERT INTO wardrobe_items
          (id, owner_id, name, category, color_name, color_hex, season, style, status, ai_tags, tag_version, image_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, 2, ?, ?)`,
          [id, owner.id, garment.name, garment.category, garment.colorName, garment.colorHex, garment.season, garment.style, JSON.stringify(aiTags), imageKey, createdAt]);
        created.push({
          id,
          name: garment.name,
          category: garment.category,
          colorName: garment.colorName,
          colorHex: garment.colorHex,
          season: garment.season,
          style: garment.style,
          aiTags,
        });
      } catch (error) {
        void error;
        if (imageKey) await storageDelete(imageKey).catch(() => undefined);
        errors.push(garment.id);
      }
    }

    // 再归并一次，既给出数据库中的真实唯一数，也收敛同一时刻的重复请求。
    const current = await reconcileStarterCatalog(owner.id, gender, items);
    const saved = current.size;
    const added = created.length;
    const failed = errors.length;
    const reused = added === 0 && failed === 0 && saved === items.length;
    const payload = {
      saved,
      added,
      failed,
      catalogSize: items.length,
      reused,
      gender,
      starterGender: gender,
      items: created,
      hint: failed ? `${saved} 件可用，${failed} 件稍后可重试` : undefined,
    };
    if (!saved) {
      return ownerJson({ ...payload, error: "预设衣柜暂时没有准备好，请稍后重试" }, owner, 500);
    }
    return ownerJson(payload, owner, failed ? 207 : added ? 201 : 200);
  } catch (error) {
    return apiErrorResponse(request, error, "预设衣柜生成失败");
  }
}

export function DELETE(request: Request) {
  return withProtectedApiRequest(request, handleDELETE, "移除预设衣柜失败");
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "预设衣柜生成失败");
}
