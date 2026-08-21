import { dbAll } from "../../../lib/db";
import { getOwner, ownerJson } from "../../../lib/owner";
import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { normalizeGarmentAITags } from "../../../lib/garment-tags";
import { reviewOutfit, type WardrobeMatchItem } from "../../../lib/outfit-engine";
import { apiErrorResponse } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";

type WardrobeRow = {
  id: string;
  name: string;
  category: string;
  colorName: string;
  season: string;
  style: string;
  aiTags: string;
};

function parseTags(row: WardrobeRow) {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(row.aiTags || "{}");
  } catch {
    parsed = {};
  }
  return normalizeGarmentAITags(parsed, { category: row.category, color: row.colorName, season: row.season, style: row.style });
}

async function aiSuggestion(items: WardrobeMatchItem[], breakdown: Record<string, number>, scene: string) {
  try {
    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const baseUrl = (getServerEnv("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    const model = getServerEnv("DASHSCOPE_VISION_MODEL") || "qwen3-vl-flash";
    const itemDesc = items.map(item => `${item.name}（${item.category}·${item.colorName}）`).join("、");
    const prompt = `你是易搭的穿搭顾问。用户手动搭配了一套：${itemDesc}。场景是${scene}。
系统从颜色、版型、场合、天气四方面打分（满分100）：颜色${Math.round(breakdown.color)}、版型${Math.round(breakdown.silhouette)}、场合${Math.round(breakdown.occasion)}、天气${Math.round(breakdown.weather)}。
请用朋友口吻写一段点评（80字以内）：先肯定这套的优点，再给一个具体的小改进建议（比如换某件单品、调整颜色或比例）。不要提分数、算法或编号。只返回点评文字本身。`;
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        enable_thinking: false,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = payload.choices?.[0]?.message?.content?.trim() || "";
    return text || "这套搭配整体不错，颜色和比例都比较协调，可以直接穿出门。";
  } catch {
    return "这套搭配整体不错，颜色和比例都比较协调，可以直接穿出门。";
  }
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  try {
    const body = await request.json() as {
      itemIds?: unknown;
      scene?: string;
      weather?: Record<string, unknown>;
      profile?: Record<string, unknown>;
    };
    const rawIds = Array.isArray(body.itemIds) ? body.itemIds.map(String) : [];
    const itemIds = [...new Set(rawIds)].slice(0, 8);
    if (itemIds.length < 2) return ownerJson({ error: "至少选择 2 件单品" }, owner, 400);

    const placeholders = itemIds.map(() => "?").join(",");
    const rows = await dbAll<WardrobeRow>(
      `SELECT id, name, category, color_name AS colorName, season, style, ai_tags AS aiTags
       FROM wardrobe_items WHERE owner_id = ? AND id IN (${placeholders})`,
      [owner.id, ...itemIds],
    );
    if (rows.length !== itemIds.length) return ownerJson({ error: "部分单品已不在衣柜，请重新选择" }, owner, 409);

    const ordered = itemIds.map(id => rows.find(row => row.id === id)!).filter(Boolean);
    const items: WardrobeMatchItem[] = ordered.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      colorName: row.colorName,
      season: row.season,
      style: row.style,
      aiTags: parseTags(row),
    }));

    const scene = String(body.scene || "休闲").slice(0, 16);
    const review = reviewOutfit(items, {
      scene,
      prompt: "",
      weather: body.weather,
      profile: body.profile,
    });

    const suggestion = await aiSuggestion(items, review.breakdown, scene);

    return ownerJson({
      score: review.score,
      breakdown: review.breakdown,
      highlights: review.highlights,
      suggestion,
      items: ordered.map(item => ({
        id: item.id,
        name: item.name,
        category: item.category,
        colorName: item.colorName,
        imageUrl: `/api/wardrobe?image=${item.id}`,
      })),
    }, owner);
  } catch (error) {
    return apiErrorResponse(request, error, "搭配点评失败");
  }
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "搭配点评失败");
}
