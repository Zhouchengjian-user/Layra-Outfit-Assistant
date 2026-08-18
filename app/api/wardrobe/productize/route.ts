import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { encodeGarmentTags, normalizeGarmentAITags } from "../../../lib/garment-tags";

type GenerationPayload = {
  code?: string;
  message?: string;
  output?: {
    choices?: Array<{ message?: { content?: Array<{ image?: string }> } }>;
  };
};

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function productPrompt(category: string, color: string) {
  const quantity = category.includes("鞋") ? "只保留同一双鞋，两只鞋自然并排完整展示" : category.includes("首饰") ? "只保留同一件或同一对首饰；若原图无法确认其真实结构，不得编造新品" : "只保留这一件单品";
  const categoryRule = category.includes("上衣") || category.includes("外套")
    ? "上衣必须独立平铺或隐形衣架陈列，领口和袖口自然中空；严禁出现人体躯干、脖子、皮肤、手臂、裤子、裙子、腰带或模特轮廓。"
    : category.includes("裤") || category.includes("裙") || category.includes("下装")
      ? "下装必须从腰头到裤脚或裙摆完整展示；严禁出现上衣、人体腰腿、脚、袜子和鞋。裤脚必须干净结束，不得把原图中的鞋生成在裤子下面。"
      : category.includes("鞋")
        ? "只展示鞋本身；严禁出现脚、袜子、裤脚、腿、鞋盒或地面。"
        : category.includes("帽")
          ? "只展示帽子本身；严禁出现头部、头发、脸和衣服。"
          : category.includes("腰带")
            ? "只展示一条完整腰带，带身与扣头清楚可见，可水平平铺或自然盘成单圈；严禁出现人体腰部、皮肤、上衣、裤子和其他配饰。"
          : category.includes("包")
            ? "只展示包本身；严禁出现手、人体、衣服和随身杂物。"
            : "只展示原图中真实可见的目标配饰，保持真实形状和材质；严禁根据服装花纹、纽扣或衣物装饰虚构首饰。";
  return `把输入图中可见的${color}${category}重建为高清电商商品主图。${quantity}。
${categoryRule}
去除人物、人体、皮肤、头发、手、脚、腿、其他衣服、其他配饰、衣架、地面、房间、背景和所有无关物体。
根据可见结构谨慎补全被身体或其他物品遮挡的部分，严格保持原单品的颜色、轮廓、版型、面料、纹理、图案、缝线、纽扣、口袋、鞋带、鞋底和可见标识，不改变款式，不增加装饰。
商品必须完整，不裁切，居中，占画面约76%，自然标准陈列。纯白色 #FFFFFF 背景，均匀柔和影棚光，无模特、无道具、无文字、无水印、无边框。输出清晰写实的高清商品摄影。`;
}

function validationRule(category: string) {
  if (category.includes("上衣") || category.includes("外套")) return "不得包含脖子、皮肤、人体躯干、手臂、裤子、裙子或腰带";
  if (category.includes("裤") || category.includes("裙") || category.includes("下装")) return "不得包含上衣、人体、腿脚、袜子或鞋，裤脚/裙摆必须完整结束";
  if (category.includes("鞋")) return "不得包含脚、袜子、裤脚或腿";
  if (category.includes("帽")) return "不得包含头、脸、头发或衣服";
  if (category.includes("腰带")) return "腰带带身和扣头必须完整，不得包含人体腰部、皮肤、上衣或裤子";
  return "不得包含人体、其他衣物或模型虚构的无关物品";
}

async function validateProductImage(sourceImage: string, imageUrl: string, category: string, color: string) {
  try {
    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const baseUrl = (getServerEnv("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    const model = getServerEnv("DASHSCOPE_VISION_MODEL") || "qwen3-vl-flash";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        enable_thinking: false,
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: sourceImage } },
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: `图一是原始裁剪，可能包含人物和其他衣物；图二是根据图一生成的商品图。目标是${color}${category}。
先做质量判断：目标单品在图一中应足够完整；图二要与图一的类别、主色、长度、轮廓、版型和图案一致；图二只能有目标商品；${validationRule(category)}；背景纯白或接近纯白。如果图一目标被遮住大半，或图二混入其他衣服，quality 必须为 REVIEW，否则为 PASS。
再为后续AI穿搭生成结构化标签：
- subcategory：具体品类，如风衣、针织衫、阔腿裤、玛丽珍鞋、腋下包；
- material：主要视觉材质；pattern：纯色/条纹/格纹/印花/波点/图案；fit：修身/合体/宽松；length：短款/常规/长款；
- colorTone：浅暖色/深暖色/浅冷色/深冷色/中性色；layer：内搭/外层/下装/连体/鞋履/配饰；
- warmth、formality：1到5整数；styles 最多3个；occasions 只能从通勤、约会、休闲、聚会、运动、正式活动中选；seasons 从春、夏、秋、冬中选；weather 从炎热、微凉、寒冷、有风、小雨中选。
只返回严格JSON对象，不要解释：{"quality":"PASS或REVIEW","tags":{"subcategory":"","material":"","pattern":"","fit":"","length":"","colorTone":"","layer":"","warmth":3,"formality":3,"styles":[],"occasions":[],"seasons":[],"weather":[]}}` },
        ] }],
        max_tokens: 280,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content || "";
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    const parsed = start >= 0 && end > start ? JSON.parse(stripped.slice(start, end + 1)) as { quality?: string; tags?: unknown } : {};
    return {
      quality: response.ok && parsed.quality === "PASS" ? "good" as const : "review" as const,
      tags: normalizeGarmentAITags(parsed.tags, { category, color }),
    };
  } catch {
    return { quality: "review" as const, tags: normalizeGarmentAITags(null, { category, color }) };
  }
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      return Response.json({ error: "请上传需要生成商品图的单品照片" }, { status: 400 });
    }
    if (image.size > 5 * 1024 * 1024) {
      return Response.json({ error: "单品图片不能超过 5MB" }, { status: 400 });
    }

    const category = String(form.get("category") || "服饰").trim().slice(0, 20);
    const color = String(form.get("color") || "").trim().slice(0, 20);
    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const endpoint = getServerEnv("DASHSCOPE_IMAGE_ENDPOINT") || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
    const model = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_MODEL") || "qwen-image-2.0";
    const size = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_SIZE") || "1536*1536";
    const imageData = `data:${image.type};base64,${toBase64(await image.arrayBuffer())}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: "user", content: [
          { image: imageData },
          { text: productPrompt(category, color) },
        ] }] },
        parameters: {
          n: 1,
          negative_prompt: "人物，模特，人体轮廓，假人，皮肤，脖子，头发，手，脚，腿，袜子，其他衣物，其他配饰，背景，地面，家具，杂物，道具，衣架，额外商品，重复商品，虚构首饰，裁切，模糊，低清晰度，文字，水印，边框，变形，改变款式",
          prompt_extend: false,
          watermark: false,
          size,
        },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const payload = await response.json() as GenerationPayload;
    const generatedUrl = payload.output?.choices?.[0]?.message?.content?.find(item => item.image)?.image || "";
    if (!response.ok || !generatedUrl) {
      throw new Error(payload.message || payload.code || "高清商品图生成失败");
    }

    const [validation, generated] = await Promise.all([
      validateProductImage(imageData, generatedUrl, category, color),
      fetch(generatedUrl, { signal: AbortSignal.timeout(60_000) }),
    ]);
    if (!generated.ok) throw new Error("高清商品图下载失败");
    return new Response(await generated.arrayBuffer(), {
      headers: {
        "Content-Type": generated.headers.get("Content-Type") || "image/png",
        "Cache-Control": "no-store",
        "X-Yida-Quality": validation.quality,
        "X-Yida-Output": "product-image-hd",
        "X-Yida-Tags": encodeGarmentTags(validation.tags),
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "高清商品图生成失败" }, { status: 500 });
  }
}
