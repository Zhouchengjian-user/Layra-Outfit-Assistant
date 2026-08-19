import { getOwner, ownerJson, withOwnerCookie } from "../../lib/owner";
import { dbFirst, dbRun, ensureSchema } from "../../lib/db";
import { storageDelete, storageGet, storagePut } from "../../lib/storage";

export async function GET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const row = await dbFirst<Record<string, string | number>>(`SELECT image_key AS imageKey, content_type AS contentType,
      quality, created_at AS createdAt, updated_at AS updatedAt FROM model_profiles WHERE owner_id = ?`, [owner.id]);
    if (!row) return ownerJson({ profile: null }, owner);
    if (new URL(request.url).searchParams.get("image") === "1") {
      const object = await storageGet(String(row.imageKey));
      if (!object) return ownerJson({ error: "模特照片不存在" }, owner, 404);
      const headers = new Headers({ "Content-Type": object.contentType, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" });
      return withOwnerCookie(new Response(object.body, { headers }), owner);
    }
    return ownerJson({ profile: { quality: row.quality, createdAt: row.createdAt, updatedAt: row.updatedAt, imageUrl: `/api/model-profile?image=1&v=${row.updatedAt}` } }, owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "个人模特加载失败" }, owner, 500);
  }
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) return ownerJson({ error: "请选择一张全身照" }, owner, 400);
    if (image.size > 12 * 1024 * 1024) return ownerJson({ error: "全身照不能超过 12MB" }, owner, 400);
    const old = await dbFirst<{ imageKey: string; createdAt: number }>("SELECT image_key AS imageKey, created_at AS createdAt FROM model_profiles WHERE owner_id = ?", [owner.id]);
    const now = Date.now();
    const contentType = ["image/jpeg", "image/png", "image/webp"].includes(image.type) ? image.type : "image/jpeg";
    const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
    const imageKey = `model-profiles/${owner.id}/${crypto.randomUUID()}.${extension}`;
    await storagePut(imageKey, image.stream(), contentType);
    if (old) {
      await dbRun("UPDATE model_profiles SET image_key = ?, content_type = ?, quality = 'ready', updated_at = ? WHERE owner_id = ?",
        [imageKey, contentType, now, owner.id]);
    } else {
      await dbRun("INSERT INTO model_profiles (owner_id, image_key, content_type, quality, created_at, updated_at) VALUES (?, ?, ?, 'ready', ?, ?)",
        [owner.id, imageKey, contentType, now, now]);
    }
    if (old?.imageKey && old.imageKey !== imageKey) await storageDelete(old.imageKey);
    return ownerJson({ profile: { quality: "ready", createdAt: old?.createdAt ?? now, updatedAt: now, imageUrl: `/api/model-profile?image=1&v=${now}` } }, owner, 201);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "全身照保存失败" }, owner, 500);
  }
}

export async function DELETE(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const row = await dbFirst<{ imageKey: string }>("SELECT image_key AS imageKey FROM model_profiles WHERE owner_id = ?", [owner.id]);
    if (row) {
      await dbRun("DELETE FROM model_profiles WHERE owner_id = ?", [owner.id]);
      await storageDelete(row.imageKey);
    }
    return ownerJson({ ok: true }, owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "删除失败" }, owner, 500);
  }
}
