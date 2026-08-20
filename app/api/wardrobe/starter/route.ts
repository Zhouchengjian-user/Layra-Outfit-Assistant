import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { getOwner, ownerJson } from "../../../lib/owner";
import { dbAll, dbRun, ensureSchema } from "../../../lib/db";
import { storageGet, storagePut } from "../../../lib/storage";
import { starterGarmentsFor } from "../../../lib/starter-wardrobe";
import sharp from "sharp";

/**
 * 预设衣柜：服务端按性别生成/复用真实商品图，一次生成全局缓存，
 * 之后任何用户秒级入库（图片与标签都真实，可编辑、可参与推荐与试穿）。
 */

type ItemRow = { id: string };

async function fetchImageUrl(url: string, timeoutMs = 60_000): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error("预设商品图下载失败");
  return { buffer: await response.arrayBuffer(), contentType: response.headers.get("Content-Type") || "image/png" };
}

/** 压缩成 512×512 JPEG（白底填充），供衣柜展示与推荐使用，避免大图加载慢/裂图。 */
async function compressForWardrobe(buffer: ArrayBuffer | Uint8Array): Promise<Buffer> {
  return sharp(buffer)
    .resize(512, 512, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 84 })
    .toBuffer();
}

async function generateProductImage(drawPrompt: string): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
  const endpoint = getServerEnv("DASHSCOPE_IMAGE_ENDPOINT") || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
  const model = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_MODEL") || "qwen-image-2.0";
  const size = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_SIZE") || "1024*1024";
  const prompt = `一张真实服装摄影风格的电商白底商品图，单品：${drawPrompt}。
要求：单品完整居中平铺展示，纯白色干净背景，柔和均匀光影，真实材质纹理，高清细节，无人物、无模特、无假人、无手、无衣架、无文字、无水印、无边框，仅一件单品，正面视角，简洁高级。`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      input: { messages: [{ role: "user", content: [{ text: prompt }] }] },
      parameters: { n: 1, negative_prompt: "人物，模特，人体，假人，皮肤，手，手指，衣架，背景，家具，杂物，道具，文字，水印，边框，多件，重复", prompt_extend: false, watermark: false, size },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json() as {
    output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
    message?: string;
    code?: string;
  };
  const imageUrl = payload.output?.choices?.[0]?.message?.content?.find(item => item.image)?.image || "";
  if (!response.ok || !imageUrl) throw new Error(payload.message || payload.code || "预设商品图生成失败");
  return fetchImageUrl(imageUrl);
}

/** 取缓存图；不存在时生成并写入缓存（单次重试容错）。 */
async function cachedProductImage(garmentId: string, drawPrompt: string) {
  const cacheKey = `starter-products/${garmentId}.image`;
  const cached = await storageGet(cacheKey);
  if (cached) return { buffer: cached.body.buffer.slice(0), contentType: cached.contentType };
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const generated = await generateProductImage(drawPrompt);
      try {
        await storagePut(cacheKey, generated.buffer, generated.contentType);
      } catch {
        // 缓存写入失败不影响本次
      }
      return generated;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 2500));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("预设商品图生成失败");
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const body = await request.json().catch(() => ({})) as { gender?: string };
    const gender = body.gender === "男" ? "男" : "女";
    const items = starterGarmentsFor(gender);

    // 已有该性别的预设单品则直接返回（幂等，按名称判断，id 每次新建避免全局冲突）
    const existing = await dbAll<ItemRow>(`SELECT id FROM wardrobe_items WHERE owner_id = ? AND name IN (${items.map(() => "?").join(",")})`, [owner.id, ...items.map(item => item.name)]);
    if (existing.length >= items.length) {
      return ownerJson({ saved: existing.length, reused: true, gender }, owner);
    }

    const created = new Array<{ id: string; name: string; category: string; colorName: string; colorHex: string; season: string; style: string; aiTags: Record<string, unknown> }>(items.length);
    const errors = new Array<string | null>(items.length).fill(null);
    // 串行生成：qwen-image 对并发敏感，串行 + 单次重试最稳
    for (let index = 0; index < items.length; index++) {
      const garment = items[index];
      try {
        const { buffer } = await cachedProductImage(garment.id, garment.drawPrompt);
        const id = crypto.randomUUID();
        // 入库用压缩图（512 JPEG 约 20-40KB），原图保留在全局缓存
        const compressed = await compressForWardrobe(buffer);
        const imageKey = `${owner.id}/${id}.jpg`;
        const createdAt = Date.now();
        await storagePut(imageKey, compressed, "image/jpeg");
        await dbRun(`INSERT INTO wardrobe_items
          (id, owner_id, name, category, color_name, color_hex, season, style, status, ai_tags, tag_version, image_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, 2, ?, ?)`,
          [id, owner.id, garment.name, garment.category, garment.colorName, garment.colorHex, garment.season, garment.style, JSON.stringify(garment.aiTags), imageKey, createdAt]);
        created[index] = {
          id,
          name: garment.name,
          category: garment.category,
          colorName: garment.colorName,
          colorHex: garment.colorHex,
          season: garment.season,
          style: garment.style,
          aiTags: garment.aiTags,
        };
      } catch (error) {
        errors[index] = error instanceof Error ? error.message : "生成失败";
      }
    }

    const completed = created.filter(Boolean);
    if (!completed.length) {
      return ownerJson({ error: errors.find(Boolean) || "预设衣柜暂时没有准备好，请稍后重试" }, owner, 500);
    }
    const failedCount = errors.filter(Boolean).length;
    return ownerJson({
      saved: completed.length,
      failed: failedCount,
      gender,
      items: completed,
      hint: failedCount ? `${completed.length} 件已入柜，${failedCount} 件稍后可重试` : undefined,
    }, owner, failedCount ? 207 : 201);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "预设衣柜生成失败" }, owner, 500);
  }
}
