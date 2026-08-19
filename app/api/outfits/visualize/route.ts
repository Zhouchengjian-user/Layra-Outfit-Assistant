import { env } from "cloudflare:workers";
import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { getOwner, ownerJson, withOwnerCookie } from "../../../lib/owner";

type VisualizeEnv = { DB: D1Database; WARDROBE_IMAGES: R2Bucket };
type ImageRow = { id: string; name: string; category: string; imageKey: string };
type GenerationPayload = { code?: string; message?: string; output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> } };

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

async function r2DataUrl(bucket: R2Bucket, key: string, fallbackType = "image/jpeg") {
  const object = await bucket.get(key);
  if (!object) throw new Error("生成所需的图片不存在");
  const contentType = object.httpMetadata?.contentType || fallbackType;
  return `data:${contentType};base64,${toBase64(await object.arrayBuffer())}`;
}

export async function POST(request: Request) {
  const owner = getOwner(request);
  const storage = env as unknown as VisualizeEnv;
  try {
    const body = await request.json() as { itemIds?: string[]; title?: string; scene?: string; prompt?: string };
    const itemIds = [...new Set((body.itemIds || []).map(String))].slice(0, 6);
    if (!itemIds.length) return ownerJson({ error: "请先选择一套搭配" }, owner, 400);
    const profile = await storage.DB.prepare("SELECT image_key AS imageKey, content_type AS contentType FROM model_profiles WHERE owner_id = ?")
      .bind(owner.id).first<{ imageKey: string; contentType: string }>();
    if (!profile) return ownerJson({ error: "请先上传一张清晰的个人全身照" }, owner, 400);
    const placeholders = itemIds.map(() => "?").join(",");
    const result = await storage.DB.prepare(`SELECT id, name, category, image_key AS imageKey FROM wardrobe_items
      WHERE owner_id = ? AND status = 'available' AND id IN (${placeholders})`)
      .bind(owner.id, ...itemIds).all<ImageRow>();
    const rows = result.results || [];
    if (rows.length !== itemIds.length) return ownerJson({ error: "搭配中的部分衣物已不在衣柜，请重新推荐" }, owner, 409);
    const ordered = itemIds.map(id => rows.find(item => item.id === id)!).filter(Boolean);
    const [modelImage, ...garmentImages] = await Promise.all([
      r2DataUrl(storage.WARDROBE_IMAGES, profile.imageKey, profile.contentType),
      ...ordered.map(item => r2DataUrl(storage.WARDROBE_IMAGES, item.imageKey)),
    ]);
    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const endpoint = getServerEnv("DASHSCOPE_IMAGE_ENDPOINT") || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
    const model = getServerEnv("DASHSCOPE_TRYON_IMAGE_MODEL") || getServerEnv("DASHSCOPE_PRODUCT_IMAGE_MODEL") || "qwen-image-2.0";
    const content: Array<{ image?: string; text?: string }> = [{ image: modelImage }];
    garmentImages.forEach(image => content.push({ image }));
    content.push({ text: `图一是用户本人的全身照，后续图片依次是用户衣柜中的真实单品：${ordered.map(item => `${item.name}（${item.category}）`).join("、")}。
生成一张写实、高清、完整全身的穿搭效果图。必须保留图一人物的脸部身份、发型、肤色、身材比例和自然神态，让人物准确穿上后续图片中的全部单品；保持每件单品的主色、版型、长度、材质、纹理和可见图案，不得换成相似款，不得增加衣柜之外的衣服、鞋子、帽子或包。
场景为${String(body.scene || "日常").slice(0, 20)}，搭配方案是${String(body.title || "今日搭配").slice(0, 30)}，补充要求：${String(body.prompt || "自然、舒适、比例协调").slice(0, 180)}。
人物从头到脚完整入镜，双脚不可裁切，站姿自然，简洁高级的浅灰影棚背景，柔和自然光，真实服装摄影质感，无文字、无水印、无边框、无多人、无额外肢体。` });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: "user", content }] },
        parameters: {
          n: 1, prompt_extend: false, watermark: false, size: getServerEnv("DASHSCOPE_TRYON_IMAGE_SIZE") || "1536*1536",
          negative_prompt: "换脸，陌生人，改变身份，改变发型，改变体型，半身，裁脚，裁头，多人，额外衣物，错误鞋子，错误配饰，衣服变色，改变图案，低清晰度，模糊，畸形肢体，多余手指，文字，水印，边框",
        },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json() as GenerationPayload;
    const generatedUrl = payload.output?.choices?.[0]?.message?.content?.find(item => item.image)?.image || "";
    if (!response.ok || !generatedUrl) throw new Error(payload.message || payload.code || "个人穿搭效果图生成失败");
    const generated = await fetch(generatedUrl, { signal: AbortSignal.timeout(60_000) });
    if (!generated.ok) throw new Error("效果图下载失败");
    const headers = new Headers({ "Content-Type": generated.headers.get("Content-Type") || "image/png", "Cache-Control": "private, no-store", "X-Yida-Output": "personal-outfit-preview" });
    return withOwnerCookie(new Response(await generated.arrayBuffer(), { headers }), owner);
  } catch (error) {
    return ownerJson({ error: error instanceof Error ? error.message : "个人穿搭效果图生成失败" }, owner, 500);
  }
}
