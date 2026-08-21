import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { getOwner, ownerJson } from "../../../lib/owner";
import { dbAll } from "../../../lib/db";
import {
  completeAiTask,
  ensureAiTaskSchema,
  failAiTask,
  getAiTask,
  readIdempotencyKey,
  startAiTask,
  taskPayload,
} from "../../../lib/ai-tasks";
import { normalizeGarmentAITags } from "../../../lib/garment-tags";
import {
  buildOutfitCandidates,
  selectDiverseCandidates,
  type OutfitCandidate,
  type StyleIntensity,
  type StylingIntent,
  type WardrobeMatchItem,
} from "../../../lib/outfit-engine";
import { apiErrorResponse } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";

type WardrobeRow = {
  id: string; name: string; category: string; colorName: string; season: string; style: string; aiTags: string;
};
type Recommendation = {
  id: string; title: string; reason: string; score: number; itemIds: string[]; highlights: string[];
  scoreBreakdown: OutfitCandidate["scoreBreakdown"]; missingSuggestion?: string;
};

function parseJsonObject(content: string) {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型没有返回搭配方案");
  return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
}

function sanitizeDisplayText(value: unknown, items: WardrobeRow[], fallback = "") {
  let text = String(value || fallback);
  for (const item of [...items].sort((a, b) => b.id.length - a.id.length)) text = text.replaceAll(item.id, "");
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "")
    .replace(/[（(]\s*(?:或|和|、|,|，|\/|\s)*[）)]/g, "")
    .replace(/\s+([，。；：、！？])/g, "$1")
    .replace(/([，、])\s*([，、])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function candidateForModel(candidate: OutfitCandidate) {
  return {
    candidateId: candidate.id,
    baseScore: candidate.score,
    scoreBreakdown: candidate.scoreBreakdown,
    highlights: candidate.highlights,
    items: candidate.items.map(item => ({
      name: item.name,
      category: item.category,
      color: item.colorName,
      subcategory: item.aiTags.subcategory,
      material: item.aiTags.material,
      pattern: item.aiTags.pattern,
      fit: item.aiTags.fit,
      length: item.aiTags.length,
      silhouette: item.aiTags.silhouette,
      role: item.aiTags.role,
    })),
  };
}

function recommendationFromCandidate(
  candidate: OutfitCandidate,
  look: Record<string, unknown> | undefined,
  items: WardrobeRow[],
): Recommendation {
  const readableNames = candidate.items.map(item => item.name).join("、");
  return {
    // 每次生成唯一 id：避免“换一批”后与上一轮 look-1/2/3 同名，导致试穿缓存串图
    id: `look-${crypto.randomUUID()}`,
    title: sanitizeDisplayText(look?.title, items, candidate.title).slice(0, 24),
    reason: sanitizeDisplayText(
      look?.reason,
      items,
      `${readableNames}在颜色、比例和场合上更协调，都是你衣柜里可以直接穿的单品。`,
    ).slice(0, 220),
    score: candidate.score,
    scoreBreakdown: candidate.scoreBreakdown,
    itemIds: candidate.itemIds,
    highlights: Array.isArray(look?.highlights)
      ? look.highlights.map(value => sanitizeDisplayText(value, items)).filter(Boolean).slice(0, 4)
      : candidate.highlights,
    missingSuggestion: sanitizeDisplayText(look?.missingSuggestion, items, candidate.missingSuggestion || "").slice(0, 80) || undefined,
  };
}

function candidateOverlap(left: OutfitCandidate, right: OutfitCandidate) {
  const leftIds = new Set(left.itemIds);
  const rightIds = new Set(right.itemIds);
  const intersection = [...leftIds].filter(id => rightIds.has(id)).length;
  return intersection / Math.max(new Set([...leftIds, ...rightIds]).size, 1);
}

function normalizeResult(value: Record<string, unknown>, candidates: OutfitCandidate[], items: WardrobeRow[], intent: StylingIntent) {
  const candidateMap = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const rawLooks = Array.isArray(value.recommendations) ? value.recommendations : [];
  const chosen: Array<{ candidate: OutfitCandidate; look?: Record<string, unknown> }> = [];
  for (const entry of rawLooks) {
    if (!entry || typeof entry !== "object") continue;
    const look = entry as Record<string, unknown>;
    const candidate = candidateMap.get(String(look.candidateId || ""));
    if (!candidate || chosen.some(selection => selection.candidate.id === candidate.id || candidateOverlap(selection.candidate, candidate) > .68)) continue;
    chosen.push({ candidate, look });
    if (chosen.length === 3) break;
  }
  for (const candidate of selectDiverseCandidates(candidates, 3, .68)) {
    if (!chosen.some(selection => selection.candidate.id === candidate.id)) chosen.push({ candidate });
    if (chosen.length === 3) break;
  }
  return {
    intent,
    recommendations: chosen.slice(0, 3).map(selection => recommendationFromCandidate(selection.candidate, selection.look, items)),
  };
}

function completedPayload(taskResult: string | null) {
  if (!taskResult) throw new Error("搭配结果不完整，请重新生成");
  return JSON.parse(taskResult) as Record<string, unknown>;
}

async function handleGET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureAiTaskSchema();
    const taskId = new URL(request.url).searchParams.get("taskId") || "";
    const task = await getAiTask(owner.id, "outfit-recommendation", taskId);
    if (!task) return ownerJson({ error: "没有找到这次搭配任务" }, owner, 404);
    if (task.status === "succeeded") return ownerJson({ ...completedPayload(task.resultJson), task: taskPayload(task) }, owner);
    if (task.status === "failed") return ownerJson({ task: taskPayload(task), error: "搭配生成失败，请点击重试" }, owner, 409);
    return ownerJson({ task: taskPayload(task) }, owner, 202);
  } catch (error) {
    return apiErrorResponse(request, error, "搭配任务查询失败");
  }
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return ownerJson({ error: "请刷新页面后重新提交", code: "INVALID_IDEMPOTENCY_KEY" }, owner, 400);
  let taskId = "";
  try {
    await ensureAiTaskSchema();
    const existing = await getAiTask(owner.id, "outfit-recommendation", idempotencyKey);
    if (existing?.status === "succeeded") return ownerJson({ ...completedPayload(existing.resultJson), task: taskPayload(existing) }, owner);
    if (existing?.status === "failed") return ownerJson({ task: taskPayload(existing), error: "上次搭配生成失败，请点击重试" }, owner, 409);
    if (existing) return ownerJson({ task: taskPayload(existing) }, owner, 202);
    const body = await request.json() as {
      prompt?: string; scene?: string; weather?: Record<string, unknown>; profile?: Record<string, unknown>; intensity?: StyleIntensity; closet?: string;
    };
    const scene = String(body.scene || "通勤").slice(0, 16);
    const prompt = String(body.prompt || "请推荐今天的穿搭").slice(0, 300);
    const closet = String(body.closet || "own").slice(0, 10);
    // 按当前衣柜过滤：own=用户自己的衣服，female/male=对应性别预设单品
    const closetWhere = closet === "own"
      ? " AND ai_tags NOT LIKE '%starterGender%'"
      : closet === "female" || closet === "male"
        ? ` AND ai_tags LIKE '%"starterGender":"${closet === "female" ? "女" : "男"}"%'`
        : "";
    const items = await dbAll<WardrobeRow>(`SELECT id, name, category, color_name AS colorName, season, style, ai_tags AS aiTags
      FROM wardrobe_items WHERE owner_id = ? AND status = 'available'${closetWhere} ORDER BY created_at DESC LIMIT 240`, [owner.id]);
    if (items.length < 2) return ownerJson({ error: "衣柜里至少需要 2 件可穿单品，先去添加衣服吧" }, owner, 400);

    const wardrobe: WardrobeMatchItem[] = items.map(item => {
      let parsed: unknown = {};
      try { parsed = JSON.parse(item.aiTags || "{}"); } catch { parsed = {}; }
      return {
        ...item,
        aiTags: normalizeGarmentAITags(parsed, { category: item.category, color: item.colorName, season: item.season, style: item.style }),
      };
    });
    const { intent, candidates } = buildOutfitCandidates(wardrobe, {
      scene,
      prompt,
      weather: body.weather,
      profile: body.profile,
      intensity: body.intensity,
    });
    if (!candidates.length) return ownerJson({ error: "衣柜暂时组合不出完整穿搭，请至少添加上装、下装或连衣裙" }, owner, 400);

    const started = await startAiTask(owner.id, "outfit-recommendation", idempotencyKey, JSON.stringify({ ...body, scene, prompt }));
    taskId = started.task.id;
    if (!started.created) {
      if (started.task.status === "succeeded") return ownerJson({ ...completedPayload(started.task.resultJson), task: taskPayload(started.task) }, owner);
      if (started.task.status === "failed") return ownerJson({ task: taskPayload(started.task), error: "上次搭配生成失败，请点击重试" }, owner, 409);
      return ownerJson({ task: taskPayload(started.task) }, owner, 202);
    }

    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const baseUrl = (getServerEnv("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    const model = getServerEnv("DASHSCOPE_VISION_MODEL") || "qwen3-vl-flash";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        enable_thinking: false,
        max_tokens: 900,
        messages: [{ role: "user", content: `你是易搭的时装编辑。系统已经按颜色、版型、天气、场合和偏好计算出候选搭配，你只负责从候选中挑出三套最有审美、且彼此有差异的方案，不得新增、删除或替换候选里的单品。

用户需求：${prompt}
场合：${scene}
穿搭力度：${intent.intensity}
结构化意图：${JSON.stringify(intent)}
候选搭配：${JSON.stringify(candidates.map(candidateForModel))}

选稿规则：
1. 第一套是最适合当前需求的稳妥优选；第二套要比第一套更有层次或色彩记忆点；第三套允许更有风格，但仍能实际穿出门。
2. 三套不能只是更换一个配饰；核心上装、下装、连衣裙或外套应有明显差异。若衣柜很小，优先保证真实可穿。
3. 穿搭中最多一个强主角，其他单品负责衔接；兼顾上松下收或上短下长等比例关系。
4. reason 用朋友口吻，说明颜色、比例、天气和场合，不提分数、算法、编号或 UUID。
5. 只返回严格JSON对象：{"recommendations":[{"candidateId":"candidate-01","title":"","reason":"","highlights":[],"missingSuggestion":""}]}。` }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
    if (!response.ok) throw new Error(payload.error?.message || "AI 搭配暂时不可用");
    const normalized = normalizeResult(parseJsonObject(payload.choices?.[0]?.message?.content || ""), candidates, items, intent);
    const itemMap = new Map(items.map(item => [item.id, item]));
    const resultPayload = {
      ...normalized,
      recommendations: normalized.recommendations.map(look => ({
        ...look,
        items: look.itemIds.map(id => itemMap.get(id)).filter(Boolean).map(item => ({
          ...item,
          aiTags: undefined,
          imageUrl: `/api/wardrobe?image=${item!.id}`,
        })),
      })),
    };
    await completeAiTask(taskId, { resultJson: JSON.stringify(resultPayload) });
    return ownerJson({ ...resultPayload, task: { id: taskId, kind: "outfit-recommendation", status: "succeeded", updatedAt: Date.now() } }, owner);
  } catch (error) {
    if (taskId) await failAiTask(taskId).catch(() => undefined);
    return apiErrorResponse(request, error, "搭配生成失败");
  }
}

export function GET(request: Request) {
  return withProtectedApiRequest(request, handleGET, "搭配任务查询失败");
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "搭配生成失败");
}
