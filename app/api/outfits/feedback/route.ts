import { dbAll, dbFirst, dbRun, ensureSchema } from "../../../lib/db";
import { outfitCoreKey } from "../../../lib/outfit-engine";
import { getOwner, ownerJson } from "../../../lib/owner";
import { withProtectedApiRequest } from "../../../lib/protected-route";

type FeedbackRow = { id: string; coreKey: string; action: "dislike" | "worn"; createdAt: number };

async function handleGET(request: Request) {
  const owner = getOwner(request);
  await ensureSchema();
  const feedback = await dbAll<FeedbackRow>(
    "SELECT id, core_key AS coreKey, action, created_at AS createdAt FROM outfit_feedback WHERE owner_id = ? ORDER BY created_at DESC LIMIT 500",
    [owner.id],
  );
  return ownerJson({ feedback }, owner);
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  const body = await request.json().catch(() => null) as { itemIds?: unknown; action?: unknown } | null;
  if (body?.action !== "dislike" && body?.action !== "worn") return ownerJson({ error: "无效的反馈类型" }, owner, 400);
  const itemIds = [...new Set(Array.isArray(body.itemIds) ? body.itemIds.map(String) : [])].slice(0, 6);
  if (itemIds.length < 2) return ownerJson({ error: "请先选择一套搭配" }, owner, 400);
  await ensureSchema();
  const placeholders = itemIds.map(() => "?").join(",");
  const items = await dbAll<{ id: string; category: string }>(
    `SELECT id, category FROM wardrobe_items WHERE owner_id = ? AND id IN (${placeholders})`,
    [owner.id, ...itemIds],
  );
  if (items.length !== itemIds.length) return ownerJson({ error: "部分单品已不在你的衣柜" }, owner, 409);
  const coreKey = outfitCoreKey(items);
  if (!coreKey) return ownerJson({ error: "搭配缺少上装或下装" }, owner, 400);
  const existing = await dbFirst<FeedbackRow>(
    "SELECT id, core_key AS coreKey, action, created_at AS createdAt FROM outfit_feedback WHERE owner_id = ? AND core_key = ? AND action = ? ORDER BY created_at DESC LIMIT 1",
    [owner.id, coreKey, body.action],
  );
  if (existing) return ownerJson({ feedback: existing }, owner);
  const feedback: FeedbackRow = { id: crypto.randomUUID(), coreKey, action: body.action, createdAt: Date.now() };
  await dbRun(
    "INSERT INTO outfit_feedback (id, owner_id, core_key, action, item_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [feedback.id, owner.id, coreKey, feedback.action, JSON.stringify(itemIds), feedback.createdAt],
  );
  return ownerJson({ feedback }, owner, 201);
}

export function GET(request: Request) {
  return withProtectedApiRequest(request, handleGET, "反馈加载失败");
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "反馈保存失败");
}
