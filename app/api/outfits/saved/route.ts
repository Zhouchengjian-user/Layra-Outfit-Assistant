import { dbAll, dbRun, ensureSchema } from "../../../lib/db";
import { getOwner, ownerJson } from "../../../lib/owner";
import { apiErrorResponse } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";

type SavedRow = { id: string; title: string; scene: string; itemIds: string; createdAt: number };
type ItemDetail = { id: string; name: string; category: string; colorName: string; imageUrl: string };

async function handleGET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const rows = await dbAll<SavedRow>(
      "SELECT id, title, scene, item_ids AS itemIds, created_at AS createdAt FROM saved_outfits WHERE owner_id = ? ORDER BY created_at DESC LIMIT 50",
      [owner.id],
    );
    const saved = rows.map(row => {
      let itemIds: string[] = [];
      try {
        itemIds = JSON.parse(row.itemIds);
      } catch {
        itemIds = [];
      }
      return { id: row.id, title: row.title, scene: row.scene, itemIds, createdAt: row.createdAt };
    });

    const allIds = [...new Set(saved.flatMap(item => item.itemIds))];
    const itemsMap = new Map<string, ItemDetail>();
    if (allIds.length) {
      const placeholders = allIds.map(() => "?").join(",");
      const itemRows = await dbAll<{ id: string; name: string; category: string; colorName: string }>(
        `SELECT id, name, category, color_name AS colorName FROM wardrobe_items WHERE owner_id = ? AND id IN (${placeholders})`,
        [owner.id, ...allIds],
      );
      for (const item of itemRows) {
        itemsMap.set(item.id, { ...item, imageUrl: `/api/wardrobe?image=${item.id}` });
      }
    }

    const result = saved.map(item => ({
      ...item,
      items: item.itemIds.map(id => itemsMap.get(id)).filter((detail): detail is ItemDetail => Boolean(detail)),
    }));
    return ownerJson({ saved: result }, owner);
  } catch (error) {
    return apiErrorResponse(request, error, "收藏列表加载失败");
  }
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const body = await request.json() as { itemIds?: unknown; title?: string; scene?: string };
    const rawIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
    const itemIds = [...new Set(rawIds)].slice(0, 8);
    if (itemIds.length < 2) return ownerJson({ error: "至少包含 2 件单品" }, owner, 400);
    const placeholders = itemIds.map(() => "?").join(",");
    const ownedItems = await dbAll<{ id: string }>(
      `SELECT id FROM wardrobe_items WHERE owner_id = ? AND id IN (${placeholders})`,
      [owner.id, ...itemIds],
    );
    if (ownedItems.length !== itemIds.length) {
      return ownerJson({ error: "部分单品已不在你的衣柜，请重新选择" }, owner, 409);
    }
    const id = crypto.randomUUID();
    const title = String(body.title || "我的搭配").trim().slice(0, 30);
    const scene = String(body.scene || "休闲").trim().slice(0, 20);
    const createdAt = Date.now();
    await dbRun(
      "INSERT INTO saved_outfits (id, owner_id, title, scene, item_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [id, owner.id, title, scene, JSON.stringify(itemIds), createdAt],
    );
    return ownerJson({ saved: { id, title, scene, itemIds, createdAt } }, owner, 201);
  } catch (error) {
    return apiErrorResponse(request, error, "收藏失败");
  }
}

async function handleDELETE(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureSchema();
    const id = new URL(request.url).searchParams.get("id");
    if (!id) return ownerJson({ error: "缺少收藏编号" }, owner, 400);
    await dbRun("DELETE FROM saved_outfits WHERE id = ? AND owner_id = ?", [id, owner.id]);
    return ownerJson({ ok: true }, owner);
  } catch (error) {
    return apiErrorResponse(request, error, "删除失败");
  }
}

export function GET(request: Request) {
  return withProtectedApiRequest(request, handleGET, "收藏列表加载失败");
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "收藏失败");
}

export function DELETE(request: Request) {
  return withProtectedApiRequest(request, handleDELETE, "删除失败");
}
