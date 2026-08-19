import { env } from "cloudflare:workers";
import { getOwner, ownerJson, withOwnerCookie } from "../../lib/owner";

type ModelEnv = { DB: D1Database; WARDROBE_IMAGES: R2Bucket };

let schemaReady: Promise<void> | null = null;

async function ensureSchema(database: D1Database) {
  if (!schemaReady) {
    schemaReady = database.prepare(`CREATE TABLE IF NOT EXISTS model_profiles (
      owner_id TEXT PRIMARY KEY,
      image_key TEXT NOT NULL,
      content_type TEXT NOT NULL,
      quality TEXT NOT NULL DEFAULT 'ready',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`).run().then(() => undefined).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function GET(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as ModelEnv;
  try {
    await ensureSchema(storage.DB);
    const row = await storage.DB.prepare(`SELECT image_key AS imageKey, content_type AS contentType,
      quality, created_at AS createdAt, updated_at AS updatedAt FROM model_profiles WHERE owner_id = ?`)
      .bind(owner.id).first<Record<string, string | number>>();
    if (!row) return ownerJson({ profile: null }, owner);
    if (new URL(request.url).searchParams.get("image") === "1") {
      const object = await storage.WARDROBE_IMAGES.get(String(row.imageKey));
      if (!object) return ownerJson({ error: "模特照片不存在" }, owner, 404);
      const headers = new Headers({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });
      object.writeHttpMetadata(headers);
      return withOwnerCookie(new Response(object.body, { headers }), owner);
    }
    return ownerJson({ profile: { quality: row.quality, createdAt: row.createdAt, updatedAt: row.updatedAt, imageUrl: `/api/model-profile?image=1&v=${row.updatedAt}` } }, owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "个人模特加载失败" }, owner, 500);
  }
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as ModelEnv;
  try {
    await ensureSchema(storage.DB);
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) return ownerJson({ error: "请选择一张全身照" }, owner, 400);
    if (image.size > 12 * 1024 * 1024) return ownerJson({ error: "全身照不能超过 12MB" }, owner, 400);
    const old = await storage.DB.prepare("SELECT image_key AS imageKey, created_at AS createdAt FROM model_profiles WHERE owner_id = ?")
      .bind(owner.id).first<{ imageKey: string; createdAt: number }>();
    const now = Date.now();
    const contentType = ["image/jpeg", "image/png", "image/webp"].includes(image.type) ? image.type : "image/jpeg";
    const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const imageKey = `model-profiles/${owner.id}/${crypto.randomUUID()}.${extension}`;
    await storage.WARDROBE_IMAGES.put(imageKey, image.stream(), { httpMetadata: { contentType } });
    await storage.DB.prepare(`INSERT INTO model_profiles (owner_id, image_key, content_type, quality, created_at, updated_at)
      VALUES (?, ?, ?, 'ready', ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET image_key = excluded.image_key, content_type = excluded.content_type,
        quality = excluded.quality, updated_at = excluded.updated_at`)
      .bind(owner.id, imageKey, contentType, old?.createdAt || now, now).run();
    if (old?.imageKey && old.imageKey !== imageKey) await storage.WARDROBE_IMAGES.delete(old.imageKey);
    return ownerJson({ profile: { quality: "ready", createdAt: old?.createdAt || now, updatedAt: now, imageUrl: `/api/model-profile?image=1&v=${now}` } }, owner, 201);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "全身照保存失败" }, owner, 500);
  }
}

export async function DELETE(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as ModelEnv;
  try {
    await ensureSchema(storage.DB);
    const row = await storage.DB.prepare("SELECT image_key AS imageKey FROM model_profiles WHERE owner_id = ?")
      .bind(owner.id).first<{ imageKey: string }>();
    if (row) {
      await storage.DB.prepare("DELETE FROM model_profiles WHERE owner_id = ?").bind(owner.id).run();
      await storage.WARDROBE_IMAGES.delete(row.imageKey);
    }
    return ownerJson({ ok: true }, owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "删除失败" }, owner, 500);
  }
}
