import { env } from "cloudflare:workers";
import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { getOwner, ownerJson } from "../../../lib/owner";

type OutfitEnv = { DB: D1Database };
type WardrobeRow = {
  id: string; name: string; category: string; colorName: string; season: string; style: string; aiTags: string;
};
type Intent = { occasion: string; style: string[]; warmth: number; formality: number; colorPreference: string; requirements: string[] };
type Recommendation = { id: string; title: string; reason: string; score: number; itemIds: string[]; highlights: string[]; missingSuggestion?: string };

function parseJsonObject(content: string) {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回搭配方案");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

function itemLayer(item: WardrobeRow) {
  if (["裤子", "裙子", "下装"].includes(item.category)) return "bottom";
  if (item.category === "连衣裙") return "dress";
  if (["鞋子", "鞋履"].includes(item.category)) return "shoes";
  if (item.category === "外套") return "outer";
  if (["帽子", "腰带", "包", "首饰", "配饰", "其他配饰"].includes(item.category)) return "accessory";
  return "top";
}

function fallbackRecommendations(items: WardrobeRow[], scene: string): Recommendation[] {
  const groups = new Map<string, WardrobeRow[]>();
  for (const item of items) groups.set(itemLayer(item), [...(groups.get(itemLayer(item)) || []), item]);
  const pick = (layer: string, index: number) => {
    const options = groups.get(layer) || [];
    return options.length ? options[index % options.length] : null;
  };
  return [0, 1, 2].map(index => {
    const selected = [pick("dress", index) || pick("top", index), pick("outer", index), pick("bottom", index), pick("shoes", index), pick("accessory", index)]
      .filter((item): item is WardrobeRow => Boolean(item));
    const unique = [...new Map(selected.map(item => [item.id, item])).values()];
    return {
      id: `look-${index + 1}`,
      title: ["舒服有精神", "利落有层次", "轻松不费力"][index],
      reason: `从你的衣柜里挑了 ${unique.map(item => item.name).join("、")}，适合${scene}，也方便直接照着穿。`,
      score: 90 - index * 2,
      itemIds: unique.map(item => item.id),
      highlights: [scene, index === 0 ? "颜色协调" : index === 1 ? "比例利落" : "舒适耐看"],
    };
  });
}

function normalizeResult(value: Record<string, unknown>, items: WardrobeRow[], scene: string) {
  const validIds = new Set(items.map(item => item.id));
  const rawIntent = value.intent && typeof value.intent === "object" ? value.intent as Record<string, unknown> : {};
  const intent: Intent = {
    occasion: String(rawIntent.occasion || scene).slice(0, 16),
    style: Array.isArray(rawIntent.style) ? rawIntent.style.map(String).slice(0, 4) : [],
    warmth: Math.max(1, Math.min(5, Math.round(Number(rawIntent.warmth) || 3))),
    formality: Math.max(1, Math.min(5, Math.round(Number(rawIntent.formality) || 3))),
    colorPreference: String(rawIntent.colorPreference || "不限定").slice(0, 20),
    requirements: Array.isArray(rawIntent.requirements) ? rawIntent.requirements.map(String).slice(0, 6) : [],
  };
  const rawLooks = Array.isArray(value.recommendations) ? value.recommendations : [];
  const normalized = rawLooks.flatMap((entry, index): Recommendation[] => {
    if (!entry || typeof entry !== "object") return [];
    const look = entry as Record<string, unknown>;
    const itemIds = [...new Set((Array.isArray(look.itemIds) ? look.itemIds : []).map(String).filter(id => validIds.has(id)))].slice(0, 6);
    if (!itemIds.length) return [];
    return [{
      id: `look-${index + 1}`,
      title: String(look.title || `搭配方案 ${index + 1}`).slice(0, 24),
      reason: String(look.reason || "根据你的需求和衣柜标签生成").slice(0, 180),
      score: Math.max(70, Math.min(99, Math.round(Number(look.score) || 88))),
      itemIds,
      highlights: Array.isArray(look.highlights) ? look.highlights.map(String).slice(0, 4) : [],
      missingSuggestion: look.missingSuggestion ? String(look.missingSuggestion).slice(0, 80) : undefined,
    }];
  });
  const fallbacks = fallbackRecommendations(items, scene);
  while (normalized.length < 3) normalized.push({ ...fallbacks[normalized.length], id: `look-${normalized.length + 1}` });
  return { intent, recommendations: normalized.slice(0, 3) };
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as OutfitEnv;
  try {
    const body = await request.json() as { prompt?: string; scene?: string; weather?: Record<string, unknown>; profile?: Record<string, unknown> };
    const scene = String(body.scene || "通勤").slice(0, 16);
    const result = await storage.DB.prepare(`SELECT id, name, category, color_name AS colorName, season, style, ai_tags AS aiTags
      FROM wardrobe_items WHERE owner_id = ? AND status = 'available' ORDER BY created_at DESC LIMIT 160`)
      .bind(owner.id).all<WardrobeRow>();
    const items = result.results || [];
    if (items.length < 2) return ownerJson({ error: "衣柜里至少需要 2 件可穿单品，先去添加衣服吧" }, owner, 400);

    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const baseUrl = (getServerEnv("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    const model = getServerEnv("DASHSCOPE_VISION_MODEL") || "qwen3-vl-flash";
    const wardrobe = items.map(item => ({
      id: item.id, name: item.name, category: item.category, color: item.colorName, season: item.season, style: item.style,
      tags: (() => { try { return JSON.parse(item.aiTags || "{}"); } catch { return {}; } })(),
    }));
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model, temperature: 0.25, enable_thinking: false, max_tokens: 1600,
        messages: [{ role: "user", content: `你是易搭的穿搭决策模型。先理解用户意图，再只使用给定衣柜中的单品生成3套可直接穿的搭配。
场合：${scene}
用户需求：${String(body.prompt || "请推荐今天的穿搭").slice(0, 300)}
天气：${JSON.stringify(body.weather || {})}
用户信息：${JSON.stringify(body.profile || {})}
衣柜：${JSON.stringify(wardrobe)}

规则：
1. itemIds只能使用衣柜中真实存在的id，绝不虚构单品；每套优先形成上装/外套+下装+鞋，或连衣裙+鞋，可按需加入配饰。
2. 三套要有明显差异，同时满足天气、场合、舒适度、颜色协调和版型比例。
3. reason像朋友一样轻松，说明为什么适合；缺少关键品类时仍只用衣柜现有单品，并在missingSuggestion中给出可选添置建议。
4. 只返回严格JSON对象：{"intent":{"occasion":"","style":[],"warmth":3,"formality":3,"colorPreference":"","requirements":[]},"recommendations":[{"title":"","reason":"","score":90,"itemIds":[],"highlights":[],"missingSuggestion":""}]}。` }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || "AI 搭配暂时不可用");
    const content = payload.choices?.[0]?.message?.content || "";
    const normalized = normalizeResult(parseJsonObject(content), items, scene);
    const itemMap = new Map(items.map(item => [item.id, item]));
    return ownerJson({
      ...normalized,
      recommendations: normalized.recommendations.map(look => ({
        ...look,
        items: look.itemIds.map(id => itemMap.get(id)).filter(Boolean).map(item => ({ ...item, aiTags: undefined, imageUrl: `/api/wardrobe?image=${item!.id}` })),
      })),
    }, owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "搭配生成失败" }, owner, 500);
  }
}
