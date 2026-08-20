import { normalizeGarmentAITags, type GarmentAITags } from "../../lib/garment-tags";
import { dbAll, dbFirst, dbRun, ensureSchema } from "../../lib/db";
import { storageDelete, storageGet, storagePut } from "../../lib/storage";

type Owner = { id: string; isNew: boolean };

const itemSelect = `
  SELECT id, name, category, color_name AS colorName, color_hex AS colorHex,
         season, style, status, ai_tags AS aiTags, tag_version AS tagVersion, created_at AS createdAt
  FROM wardrobe_items
`;

function getOwner(request: Request): Owner {
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)yida_owner=([a-zA-Z0-9-]{20,80})/);
  return match ? { id: match[1], isNew: false } : { id: crypto.randomUUID(), isNew: true };
}

function withOwnerCookie(response: Response, owner: Owner) {
  if (owner.isNew) response.headers.append("Set-Cookie", `yida_owner=${owner.id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`);
  return response;
}

function parseTags(value: unknown, fallback: { category: string; color: string; season?: string; style?: string }) {
  if (typeof value !== "string") return normalizeGarmentAITags(value, fallback);
  try {
    return normalizeGarmentAITags(JSON.parse(value), fallback);
  } catch {
    return normalizeGarmentAITags(null, fallback);
  }
}

function presentItem(item: Record<string, unknown>) {
  const category = String(item.category || "上衣");
  const color = String(item.colorName || "未识别");
  const season = String(item.season || "四季");
  const style = String(item.style || "简约");
  const aiTags = parseTags(item.aiTags, { category, color, season, style }) as GarmentAITags & { starterGender?: string };
  // 保留预设衣柜标记（normalize 会丢弃扩展字段）
  try {
    const raw = typeof item.aiTags === "string" ? JSON.parse(item.aiTags) : item.aiTags;
    if (raw && typeof raw === "object" && "starterGender" in raw) {
      aiTags.starterGender = String((raw as Record<string, unknown>).starterGender);
    }
  } catch {
    // 忽略解析失败
  }
  return { ...item, aiTags };
}

function json(payload: unknown, owner: Owner, status = 200) {
  return withOwnerCookie(Response.json(payload, { status }), owner);
}

export async function GET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const url = new URL(request.url);
    const imageId = url.searchParams.get("image");
    if (imageId) {
      const row = await dbFirst<{ imageKey: string }>("SELECT image_key AS imageKey FROM wardrobe_items WHERE id = ? AND owner_id = ?", [imageId, owner.id]);
      if (!row) return json({ error: "衣物不存在" }, owner, 404);
      const object = await storageGet(row.imageKey);
      if (!object) return json({ error: "图片不存在" }, owner, 404);
      const headers = new Headers({ "Content-Type": object.contentType });
      headers.set("Cache-Control", "private, max-age=31536000, immutable");
      return withOwnerCookie(new Response(object.body, { headers }), owner);
    }
    const items = await dbAll(`${itemSelect} WHERE owner_id = ? ORDER BY created_at DESC LIMIT 600`, [owner.id]);
    const presented = items.map(item => ({ ...presentItem(item), imageUrl: `/api/wardrobe?image=${item.id}` }));
    return json({ items: presented }, owner);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣柜加载失败" }, owner, 500);
  }
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) return json({ error: "请选择衣物图片" }, owner, 400);
    if (image.size > 12 * 1024 * 1024) return json({ error: "单张图片不能超过 12MB" }, owner, 400);
    const id = crypto.randomUUID();
    const contentType = image.type === "image/jpeg" ? "image/jpeg" : "image/png";
    const extension = contentType === "image/jpeg" ? "jpg" : "png";
    const imageKey = `${owner.id}/${id}.${extension}`;
    const createdAt = Date.now();
    const value = (key: string, fallback: string) => String(form.get(key) || fallback).trim().slice(0, 40);
    const category = value("category", "上衣");
    const colorName = value("colorName", "未识别");
    const season = value("season", "四季");
    const style = value("style", "简约");
    let rawTags: unknown = null;
    try { rawTags = JSON.parse(String(form.get("aiTags") || "{}")); } catch { rawTags = null; }
    const aiTags = normalizeGarmentAITags(rawTags, { category, color: colorName, season, style });
    const item = {
      id,
      name: value("name", "新衣物"),
      category,
      colorName,
      colorHex: value("colorHex", "#999999"),
      season,
      style,
      aiTags,
      tagVersion: 2,
      status: "available",
      createdAt,
      imageUrl: `/api/wardrobe?image=${id}`,
    };
    await storagePut(imageKey, image.stream(), contentType);
    await dbRun(`INSERT INTO wardrobe_items
      (id, owner_id, name, category, color_name, color_hex, season, style, status, ai_tags, tag_version, image_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, owner.id, item.name, item.category, item.colorName, item.colorHex, item.season, item.style, item.status, JSON.stringify(item.aiTags), item.tagVersion, imageKey, createdAt]);
    return json({ item }, owner, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣物保存失败" }, owner, 500);
  }
}

export async function PATCH(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const body = await request.json() as Partial<{ id: string; name: string; category: string; colorName: string; colorHex: string; season: string; style: string; status: string; aiTags: GarmentAITags }>;
    if (!body.id) return json({ error: "缺少衣物编号" }, owner, 400);
    const current = await dbFirst<Record<string, string | number>>(`${itemSelect} WHERE id = ? AND owner_id = ?`, [body.id, owner.id]);
    if (!current) return json({ error: "衣物不存在" }, owner, 404);
    const category = String(body.category ?? current.category).trim().slice(0, 20);
    const colorName = String(body.colorName ?? current.colorName).trim().slice(0, 20);
    const season = String(body.season ?? current.season).trim().slice(0, 20);
    const style = String(body.style ?? current.style).trim().slice(0, 20);
    const currentTags = parseTags(current.aiTags, { category: String(current.category), color: String(current.colorName), season: String(current.season), style: String(current.style) });
    const requestedTags = body.aiTags ?? currentTags;
    const alignedTags = {
      ...requestedTags,
      ...(category !== current.category ? { subcategory: category, layer: "" } : {}),
      ...(season !== current.season ? { seasons: [season] } : {}),
      ...(style !== current.style ? { styles: [style] } : {}),
    };
    const item = {
      ...presentItem(current),
      name: String(body.name ?? current.name).trim().slice(0, 40),
      category,
      colorName,
      colorHex: String(body.colorHex ?? current.colorHex).trim().slice(0, 12),
      season,
      style,
      status: body.status === "washing" ? "washing" : "available",
      aiTags: normalizeGarmentAITags(alignedTags, { category, color: colorName, season, style }),
      tagVersion: 2,
      imageUrl: `/api/wardrobe?image=${body.id}`,
    };
    await dbRun(`UPDATE wardrobe_items SET name = ?, category = ?, color_name = ?, color_hex = ?, season = ?, style = ?, status = ?, ai_tags = ?, tag_version = ? WHERE id = ? AND owner_id = ?`,
      [item.name, item.category, item.colorName, item.colorHex, item.season, item.style, item.status, JSON.stringify(item.aiTags), item.tagVersion, body.id, owner.id]);
    return json({ item }, owner);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣物更新失败" }, owner, 500);
  }
}

export async function DELETE(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return json({ error: "缺少衣物编号" }, owner, 400);
    const row = await dbFirst<{ imageKey: string }>("SELECT image_key AS imageKey FROM wardrobe_items WHERE id = ? AND owner_id = ?", [id, owner.id]);
    if (!row) return json({ error: "衣物不存在" }, owner, 404);
    await dbRun("DELETE FROM wardrobe_items WHERE id = ? AND owner_id = ?", [id, owner.id]);
    await storageDelete(row.imageKey);
    return json({ ok: true }, owner);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣物删除失败" }, owner, 500);
  }
}
