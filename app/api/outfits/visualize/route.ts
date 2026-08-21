import { requireServerEnv } from "../../../lib/server-env";
import { getOwner, ownerJson, withOwnerCookie } from "../../../lib/owner";
import { dbAll, dbFirst } from "../../../lib/db";
import { storageGet, storagePut } from "../../../lib/storage";
import { apiErrorResponse } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";
import {
  completeAiTask,
  ensureAiTaskSchema,
  failAiTask,
  getAiTask,
  readIdempotencyKey,
  startAiTask,
  taskPayload,
  type AiTask,
} from "../../../lib/ai-tasks";

type ImageRow = { id: string; name: string; category: string; imageKey: string };

function toBase64(buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function imageDataUrl(key: string, fallbackType = "image/jpeg") {
  const object = await storageGet(key);
  if (!object) throw new Error("生成所需的图片不存在");
  const contentType = object.contentType || fallbackType;
  return `data:${contentType};base64,${toBase64(object.body)}`;
}

async function generateTryOnImage(images: string[], prompt: string) {
  const apiKey = requireServerEnv("ARK_API_KEY");
  const response = await fetch("https://ark.cn-beijing.volces.com/api/v3/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "doubao-seedream-5-0-lite-260128",
      prompt,
      image: images,
      size: "1920x1920",
      response_format: "url",
      watermark: false,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json() as { data?: Array<{ url?: string }>; error?: { message?: string; code?: string } };
  if (!response.ok || !payload.data?.[0]?.url) {
    throw new Error(payload.error?.message || payload.error?.code || "个人穿搭效果图生成失败");
  }
  return payload.data[0].url;
}

async function storedResult(task: AiTask, owner: ReturnType<typeof getOwner>) {
  if (!task.resultKey) return ownerJson({ error: "效果图结果不完整，请重新生成" }, owner, 500);
  const object = await storageGet(task.resultKey);
  if (!object) return ownerJson({ error: "效果图已过期，请重新生成" }, owner, 410);
  const headers = new Headers({
    "Content-Type": task.resultContentType || object.contentType || "image/png",
    "Cache-Control": "private, no-store",
    "X-Yida-Output": "personal-outfit-preview",
    "X-Yida-Task-Id": task.id,
  });
  return withOwnerCookie(new Response(object.body, { headers }), owner);
}

async function handleGET(request: Request) {
  const owner = getOwner(request);
  try {
    await ensureAiTaskSchema();
    const taskId = new URL(request.url).searchParams.get("taskId") || "";
    const task = await getAiTask(owner.id, "outfit-visualization", taskId);
    if (!task) return ownerJson({ error: "没有找到这次效果图任务" }, owner, 404);
    if (task.status === "succeeded") return storedResult(task, owner);
    if (task.status === "failed") return ownerJson({ task: taskPayload(task), error: "效果图生成失败，请点击重试" }, owner, 409);
    return ownerJson({ task: taskPayload(task) }, owner, 202);
  } catch (error) {
    return apiErrorResponse(request, error, "效果图任务查询失败");
  }
}

async function handlePOST(request: Request) {
  const owner = getOwner(request);
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) return ownerJson({ error: "请刷新页面后重新生成", code: "INVALID_IDEMPOTENCY_KEY" }, owner, 400);
  let taskId = "";
  try {
    await ensureAiTaskSchema();
    const existing = await getAiTask(owner.id, "outfit-visualization", idempotencyKey);
    if (existing?.status === "succeeded") return storedResult(existing, owner);
    if (existing?.status === "failed") return ownerJson({ task: taskPayload(existing), error: "上次效果图生成失败，请点击重试" }, owner, 409);
    if (existing) return ownerJson({ task: taskPayload(existing) }, owner, 202);
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("multipart/form-data")) return ownerJson({ error: "请刷新页面后重新生成效果图" }, owner, 400);
    const form = await request.formData();
    const outfitBoard = form.get("outfitBoard");
    if (!(outfitBoard instanceof File) || !outfitBoard.type.startsWith("image/") || outfitBoard.size > 8 * 1024 * 1024) {
      return ownerJson({ error: "搭配参考图无效，请刷新页面后重试" }, owner, 400);
    }
    let submittedIds: unknown = [];
    try { submittedIds = JSON.parse(String(form.get("itemIds") || "[]")); } catch { submittedIds = []; }
    const itemIds = [...new Set((Array.isArray(submittedIds) ? submittedIds : []).map(String))].slice(0, 6);
    if (!itemIds.length) return ownerJson({ error: "请先选择一套搭配" }, owner, 400);
    const profile = await dbFirst<{ imageKey: string; contentType: string }>("SELECT image_key AS imageKey, content_type AS contentType FROM model_profiles WHERE owner_id = ?", [owner.id]);
    if (!profile) return ownerJson({ error: "请先上传一张清晰的个人全身照" }, owner, 400);
    const placeholders = itemIds.map(() => "?").join(",");
    const rows = await dbAll<ImageRow>(`SELECT id, name, category, image_key AS imageKey FROM wardrobe_items
      WHERE owner_id = ? AND status = 'available' AND id IN (${placeholders})`, [owner.id, ...itemIds]);
    if (rows.length !== itemIds.length) return ownerJson({ error: "搭配中的部分衣物已不在衣柜，请重新推荐" }, owner, 409);
    const ordered = itemIds.map(id => rows.find(item => item.id === id)!).filter(Boolean);
    const requestSummary = JSON.stringify({
      itemIds,
      title: String(form.get("title") || "今日搭配").slice(0, 30),
      scene: String(form.get("scene") || "日常").slice(0, 20),
      prompt: String(form.get("prompt") || "自然、舒适、比例协调").slice(0, 180),
    });
    const started = await startAiTask(owner.id, "outfit-visualization", idempotencyKey, requestSummary);
    taskId = started.task.id;
    if (!started.created) {
      if (started.task.status === "succeeded") return storedResult(started.task, owner);
      if (started.task.status === "failed") return ownerJson({ task: taskPayload(started.task), error: "上次效果图生成失败，请点击重试" }, owner, 409);
      return ownerJson({ task: taskPayload(started.task) }, owner, 202);
    }
    const modelImage = await imageDataUrl(profile.imageKey, profile.contentType);
    const garmentImages: string[] = [];
    for (const item of ordered) {
      garmentImages.push(await imageDataUrl(item.imageKey, "image/png"));
    }
    const images = [modelImage, ...garmentImages];
    const tryOnPrompt = `图一是用户本人的全身照（模特）。图二到图${images.length}依次是本次搭配的每一件衣柜单品，共 ${ordered.length} 件，请逐件核对、任何一件都不得遗漏。
单品清单（按图片顺序）：
${ordered.map((item, i) => `图${i + 2} = ${item.name}（${item.category}）`).join("；")}

生成一张写实、高清、完整全身的穿搭效果图，把图二到图${images.length}的每一件单品都准确穿到图一人物身上，一件都不能少：
- 上衣类穿在上身，下装类穿在下身，鞋履穿在脚上；
- 配饰（帽子、包、腰带、首饰）按真实佩戴/携带方式呈现；
- 逐件对照清单核对，确保 ${ordered.length} 件全部出现，不得漏掉任何一件、不得替换成相似款、不得增加额外单品；
- 严格保持图一人物的脸部、发型、肤色、身材比例；
- 保持每件单品的主色、版型、长度、材质、纹理和可见图案。
场景为${String(form.get("scene") || "日常").slice(0, 20)}，搭配方案是${String(form.get("title") || "今日搭配").slice(0, 30)}，补充要求：${String(form.get("prompt") || "自然、舒适、比例协调").slice(0, 180)}。
人物从头到脚完整入镜，双脚不可裁切，站姿自然，简洁高级的浅灰影棚背景，柔和自然光，真实服装摄影质感，无文字、无水印、无边框、无多人、无额外肢体。`;
    const generatedUrl = await generateTryOnImage(images, tryOnPrompt);
    const generated = await fetch(generatedUrl, { signal: AbortSignal.timeout(60_000) });
    if (!generated.ok) throw new Error("效果图下载失败");
    const resultContentType = generated.headers.get("Content-Type") || "image/png";
    const resultBytes = await generated.arrayBuffer();
    const resultKey = `outfit-results/${owner.id}/${taskId}`;
    await storagePut(resultKey, resultBytes, resultContentType);
    await completeAiTask(taskId, { resultKey, resultContentType });
    const headers = new Headers({
      "Content-Type": resultContentType,
      "Cache-Control": "private, no-store",
      "X-Yida-Output": "personal-outfit-preview",
      "X-Yida-Task-Id": taskId,
    });
    return withOwnerCookie(new Response(resultBytes, { headers }), owner);
  } catch (error) {
    if (taskId) await failAiTask(taskId).catch(() => undefined);
    return apiErrorResponse(request, error, "个人穿搭效果图生成失败");
  }
}

export function GET(request: Request) {
  return withProtectedApiRequest(request, handleGET, "效果图任务查询失败");
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "个人穿搭效果图生成失败");
}
