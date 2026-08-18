import { env } from "cloudflare:workers";
import { normalizeGarmentAITags, type GarmentAITags } from "../../lib/garment-tags";

type WardrobeEnv = {
  DB: D1Database;
  WARDROBE_IMAGES: R2Bucket;
};

type Owner = { id: string; isNew: boolean };

let schemaReady: Promise<void> | null = null;

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

async function prepareSchema(database: D1Database) {
  await database.batch([
    database.prepare(`CREATE TABLE IF NOT EXISTS wardrobe_items (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      color_name TEXT NOT NULL,
      color_hex TEXT NOT NULL,
      season TEXT NOT NULL,
      style TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      ai_tags TEXT NOT NULL DEFAULT '{}',
      tag_version INTEGER NOT NULL DEFAULT 0,
      image_key TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    database.prepare("CREATE INDEX IF NOT EXISTS idx_wardrobe_items_owner_created ON wardrobe_items(owner_id, created_at DESC)"),
  ]);
  const columns = await database.prepare("PRAGMA table_info(wardrobe_items)").all<{ name: string }>();
  const names = new Set((columns.results ?? []).map(column => column.name));
  if (!names.has("ai_tags")) await database.prepare("ALTER TABLE wardrobe_items ADD COLUMN ai_tags TEXT NOT NULL DEFAULT '{}'").run();
  if (!names.has("tag_version")) await database.prepare("ALTER TABLE wardrobe_items ADD COLUMN tag_version INTEGER NOT NULL DEFAULT 0").run();
}

async function ensureSchema(database: D1Database) {
  if (!schemaReady) {
    schemaReady = prepareSchema(database).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
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
  return { ...item, aiTags: parseTags(item.aiTags, { category, color, season, style }) };
}

function json(payload: unknown, owner: Owner, status = 200) {
  return withOwnerCookie(Response.json(payload, { status }), owner);
}

export async function GET(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as WardrobeEnv;
  try {
    await ensureSchema(storage.DB);
    const url = new URL(request.url);
    const imageId = url.searchParams.get("image");
    if (imageId) {
      const row = await storage.DB.prepare("SELECT image_key AS imageKey FROM wardrobe_items WHERE id = ? AND owner_id = ?").bind(imageId, owner.id).first<{ imageKey: string }>();
      if (!row) return json({ error: "衣物不存在" }, owner, 404);
      const object = await storage.WARDROBE_IMAGES.get(row.imageKey);
      if (!object) return json({ error: "图片不存在" }, owner, 404);
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Cache-Control", "private, max-age=31536000, immutable");
      return withOwnerCookie(new Response(object.body, { headers }), owner);
    }
    const result = await storage.DB.prepare(`${itemSelect} WHERE owner_id = ? ORDER BY created_at DESC LIMIT 600`).bind(owner.id).all();
    const items = (result.results ?? []).map(item => ({ ...presentItem(item), imageUrl: `/api/wardrobe?image=${item.id}` }));
    return json({ items }, owner);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣柜加载失败" }, owner, 500);
  }
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as WardrobeEnv;
  try {
    await ensureSchema(storage.DB);
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
      tagVersion: 1,
      status: "available",
      createdAt,
      imageUrl: `/api/wardrobe?image=${id}`,
    };
    await storage.WARDROBE_IMAGES.put(imageKey, image.stream(), { httpMetadata: { contentType } });
    await storage.DB.prepare(`INSERT INTO wardrobe_items
      (id, owner_id, name, category, color_name, color_hex, season, style, status, ai_tags, tag_version, image_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, owner.id, item.name, item.category, item.colorName, item.colorHex, item.season, item.style, item.status, JSON.stringify(item.aiTags), item.tagVersion, imageKey, createdAt).run();
    return json({ item }, owner, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣物保存失败" }, owner, 500);
  }
}

export async function PATCH(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as WardrobeEnv;
  try {
    await ensureSchema(storage.DB);
    const body = await request.json() as Partial<{ id: string; name: string; category: string; colorName: string; colorHex: string; season: string; style: string; status: string; aiTags: GarmentAITags }>;
    if (!body.id) return json({ error: "缺少衣物编号" }, owner, 400);
    const current = await storage.DB.prepare(`${itemSelect} WHERE id = ? AND owner_id = ?`).bind(body.id, owner.id).first<Record<string, string | number>>();
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
      tagVersion: 1,
      imageUrl: `/api/wardrobe?image=${body.id}`,
    };
    await storage.DB.prepare(`UPDATE wardrobe_items SET name = ?, category = ?, color_name = ?, color_hex = ?, season = ?, style = ?, status = ?, ai_tags = ?, tag_version = ? WHERE id = ? AND owner_id = ?`)
      .bind(item.name, item.category, item.colorName, item.colorHex, item.season, item.style, item.status, JSON.stringify(item.aiTags), item.tagVersion, body.id, owner.id).run();
    return json({ item }, owner);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣物更新失败" }, owner, 500);
  }
}

export async function DELETE(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as WardrobeEnv;
  try {
    await ensureSchema(storage.DB);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return json({ error: "缺少衣物编号" }, owner, 400);
    const row = await storage.DB.prepare("SELECT image_key AS imageKey FROM wardrobe_items WHERE id = ? AND owner_id = ?").bind(id, owner.id).first<{ imageKey: string }>();
    if (!row) return json({ error: "衣物不存在" }, owner, 404);
    await storage.DB.prepare("DELETE FROM wardrobe_items WHERE id = ? AND owner_id = ?").bind(id, owner.id).run();
    await storage.WARDROBE_IMAGES.delete(row.imageKey);
    return json({ ok: true }, owner);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "衣物删除失败" }, owner, 500);
  }
}
