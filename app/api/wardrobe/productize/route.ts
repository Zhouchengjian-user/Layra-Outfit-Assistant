import { getServerEnv, requireServerEnv } from "../../../lib/server-env";

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
  const quantity = category.includes("鞋") ? "只保留同一双鞋，两只鞋自然并排完整展示" : category.includes("首饰") ? "只保留同一件或同一对首饰" : "只保留这一件单品";
  return `把输入图中可见的${color}${category}重建为高清电商商品主图。${quantity}。
去除人物、人体、皮肤、头发、手、脚、腿、其他衣服、其他配饰、衣架、地面、房间、背景和所有无关物体。
根据可见结构谨慎补全被身体或其他物品遮挡的部分，严格保持原单品的颜色、轮廓、版型、面料、纹理、图案、缝线、纽扣、口袋、鞋带、鞋底和可见标识，不改变款式，不增加装饰。
商品必须完整，不裁切，居中，占画面约80%，自然标准陈列。纯白色 #FFFFFF 背景，均匀柔和影棚光，无模特、无道具、无文字、无水印、无边框。输出清晰写实的2K商品摄影。`;
}

async function validateProductImage(imageUrl: string, category: string) {
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
          { type: "image_url", image_url: { url: imageUrl } },
          { type: "text", text: `判断这是否为合格的${category}电商商品主图：画面只能有目标商品本身；不能有人体、皮肤、腿脚、其他衣物、场景或杂物；商品必须完整未裁切；背景应为纯白或接近纯白；图像应清晰。只回答 PASS 或 REVIEW。` },
        ] }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return response.ok && /^\s*PASS\s*$/i.test(payload.choices?.[0]?.message?.content || "") ? "good" : "review";
  } catch {
    return "review";
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
    const size = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_SIZE") || "2048*2048";
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
          negative_prompt: "人物，人体，皮肤，头发，手，脚，腿，其他衣物，其他配饰，背景，地面，家具，杂物，道具，衣架，额外商品，重复商品，裁切，模糊，低清晰度，文字，水印，边框，变形，改变款式",
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

    const quality = await validateProductImage(generatedUrl, category);
    const generated = await fetch(generatedUrl, { signal: AbortSignal.timeout(60_000) });
    if (!generated.ok) throw new Error("高清商品图下载失败");
    return new Response(await generated.arrayBuffer(), {
      headers: {
        "Content-Type": generated.headers.get("Content-Type") || "image/png",
        "Cache-Control": "no-store",
        "X-Yida-Quality": quality,
        "X-Yida-Output": "product-image-2k",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "高清商品图生成失败" }, { status: 500 });
  }
}
