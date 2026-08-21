import { getServerEnv, requireServerEnv } from "../../../lib/server-env";
import { requireSession, responseForAuthError } from "../../../lib/auth";
import { encodeGarmentTags, normalizeGarmentAITags, type GarmentAITags } from "../../../lib/garment-tags";
import { storageGet, storagePut } from "../../../lib/storage";
import { apiErrorResponse } from "../../../lib/observability";
import { withProtectedApiRequest } from "../../../lib/protected-route";

type CachedProduct = { quality: "good" | "review"; tags: GarmentAITags; contentType: string };

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

async function productCacheKey(buffer: ArrayBuffer, category: string, color: string) {
  const prefix = new TextEncoder().encode(`yida-product-v10\n${category}\n${color}\n`);
  const bytes = new Uint8Array(prefix.length + buffer.byteLength);
  bytes.set(prefix);
  bytes.set(new Uint8Array(buffer), prefix.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

function productResponse(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer, meta: CachedProduct, cacheStatus: "HIT" | "MISS") {
  return new Response(bytes, {
    headers: {
      "Content-Type": meta.contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Yida-Quality": meta.quality,
      "X-Yida-Output": "product-image-hd",
      "X-Yida-Tags": encodeGarmentTags(meta.tags),
      "X-Yida-Cache": cacheStatus,
    },
  });
}

function productPrompt(category: string, color: string) {
  const quantity = category.includes("鞋") ? "只保留同一双鞋，两只鞋自然并排完整展示" : category.includes("首饰") ? "只保留同一件或同一对首饰；若原图无法确认其真实结构，不得编造新品" : "只保留这一件单品";
  const categoryRule = category.includes("上衣") || category.includes("外套")
    ? "上衣必须独立平铺或隐形衣架陈列，领口和袖口自然中空；严禁出现人体躯干、脖子、皮肤、手臂、裤子、裙子、腰带或模特轮廓。严格保持原袖长：短袖保持短袖（袖口止于上臂）、长袖保持长袖（袖口至手腕），不得把短袖补全成长袖。"
    : category.includes("裤") || category.includes("裙") || category.includes("下装")
      ? "下装必须从腰头到裤脚或裙摆完整展示；严禁出现上衣、人体腰腿、脚、袜子和鞋。裤脚必须干净结束，不得把原图中的鞋生成在裤子下面。严格保持原裤长/裙长：短裤保持短裤（裤腿止于膝盖上方）、短裙保持短裙，不得拉长成长裤或长裙。"
      : category.includes("鞋")
        ? "只展示鞋本身；严禁出现脚、袜子、裤脚、腿、鞋盒或地面。"
        : category.includes("帽")
          ? "只展示帽子本身；严禁出现头部、头发、脸和衣服。"
          : category.includes("腰带")
            ? "只展示一条完整腰带，带身与扣头清楚可见，可水平平铺或自然盘成单圈；严禁出现人体腰部、皮肤、上衣、裤子和其他配饰。"
          : category.includes("包")
            ? "只展示包本身；严禁出现手、人体、衣服和随身杂物。"
            : "只展示原图中真实可见的目标配饰，保持真实形状和材质；严禁根据服装花纹、纽扣或衣物装饰虚构首饰。";
  return `把输入图中确实可见的${color}${category}重建为高清电商商品主图。${quantity}。
${categoryRule}
去除人物、人体、皮肤、头发、手、脚、腿、其他衣服、其他配饰、衣架、地面、房间、背景和所有无关物体。画面中绝对不允许出现任何人体部位、皮肤、模特或假人。
输入图只是原图中目标单品的真实裁剪。只能忠实整理这件目标，不得替换成同类通用商品，不得参考其他图片或先前任务，不得增加输入图中没有视觉证据的帽子、鞋、腰带、包、首饰、内搭或装饰。
根据可见结构谨慎补全被身体或其他物品遮挡的部分，严格保持原单品的颜色、轮廓、版型、长度、面料、纹理、图案、缝线、纽扣、口袋、鞋带、鞋底和可见标识，不改变款式，不改变主色，不改变裤长/袖长/裙长，不增加装饰。特别注意：短裤、短袖、短裙必须保持短款，严禁补全成长裤、长袖或长裙。左右结构必须完全对称：两只袖子、两条裤腿的长度和版型必须完全一致，严禁一边长一边短。
商品必须完整，不裁切，居中，占画面约76%，自然标准陈列。背景必须是纯净的白色 #FFFFFF，均匀柔和，没有任何杂质、阴影、纹理、水印或边框。输出清晰写实的高清商品摄影。`;
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
          { type: "text", text: `图一是当前这一次上传图片中截取的原始证据，可能包含人物和其他衣物；图二是根据图一生成的商品图。声明目标是${color}${category}。
先独立核验图一：只有当图一里确实清楚可见声明的目标单品时 source_evidence 才是 VISIBLE；如果只是背景、人体、文字、印花、局部颜色，或无法证明该物体存在，则为 MISSING。
再核验图二：same_item 表示图二与图一是同一件具体单品，而不只是同类商品；category_match、color_match 分别表示类别与主色一致；has_extraneous_object 表示图二混入人体、其他衣物/配饰或无关物。图二的长度、轮廓、版型、图案、口袋、纽扣等关键特征必须和图一一致；${validationRule(category)}；背景纯白或接近纯白。
只有 source_evidence=VISIBLE、same_item/category_match/color_match 均为 true、has_extraneous_object=false 且画面清晰完整时 quality 才能为 PASS。证据不足但没有明确矛盾时为 REVIEW；原图不存在目标、明显换款、变色或增加物体时为 REJECT。
再为后续AI穿搭生成结构化标签。标签用于颜色、比例、场合和风格的可计算评分：
- subcategory：具体品类，如风衣、针织衫、阔腿裤、玛丽珍鞋、腋下包；
- material：主要视觉材质；pattern：纯色/条纹/格纹/印花/波点/图案；fit：修身/合体/宽松；length：短款/常规/长款；
- colorTone：浅暖色/深暖色/浅冷色/深冷色/中性色；colorFamily：黑色/白色/灰色/米色/棕色/红色/蓝色/绿色/黄色/紫色/其他；colorTemperature：冷色/暖色/中性；lightness：浅/中/深；saturation：低/中/高；
- layer：内搭/外层/下装/连体/鞋履/配饰；silhouette：修身/直筒/宽松/廓形；visualWeight：轻盈/中等/厚重；
- waistline：短款露腰/收腰/自然/不适用；rise：高腰/中腰/低腰/不适用；legShape：直筒/阔腿/锥形/紧身/不适用；patternScale：无/小/中/大；
- statementLevel：1到5，1为极基础、5为强视觉焦点；role：基础款/主角款/过渡款/点缀款；layering：适合叠穿的位置数组，如["内搭","外层"]；
- warmth、formality：1到5整数；styles 最多3个；occasions 只能从通勤、约会、休闲、聚会、运动、正式活动中选；seasons 从春、夏、秋、冬中选；weather 从炎热、微凉、寒冷、有风、小雨中选。
只返回严格JSON对象，不要解释：{"quality":"PASS或REVIEW或REJECT","source_evidence":"VISIBLE或MISSING","same_item":true,"category_match":true,"color_match":true,"has_extraneous_object":false,"reason":"20字内","tags":{"subcategory":"","material":"","pattern":"","fit":"","length":"","colorTone":"","colorFamily":"","colorTemperature":"","lightness":"","saturation":"","layer":"","silhouette":"","visualWeight":"","waistline":"","rise":"","legShape":"","patternScale":"","statementLevel":2,"role":"","layering":[],"warmth":3,"formality":3,"styles":[],"occasions":[],"seasons":[],"weather":[]}}` },
        ] }],
        max_tokens: 560,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content || "";
    const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    const parsed = start >= 0 && end > start ? JSON.parse(stripped.slice(start, end + 1)) as {
      quality?: string;
      source_evidence?: string;
      same_item?: boolean;
      category_match?: boolean;
      color_match?: boolean;
      has_extraneous_object?: boolean;
      reason?: string;
      tags?: unknown;
    } : {};
    const hasExplicitMismatch = parsed.quality === "REJECT"
      || parsed.source_evidence === "MISSING"
      || parsed.same_item === false
      || parsed.category_match === false
      || parsed.color_match === false
      || parsed.has_extraneous_object === true;
    const strictPass = response.ok
      && parsed.quality === "PASS"
      && parsed.source_evidence === "VISIBLE"
      && parsed.same_item === true
      && parsed.category_match === true
      && parsed.color_match === true
      && parsed.has_extraneous_object === false;
    return {
      quality: strictPass ? "good" as const : "review" as const,
      rejected: hasExplicitMismatch,
      reason: String(parsed.reason || "商品图与原图不一致").slice(0, 60),
      tags: normalizeGarmentAITags(parsed.tags, { category, color }),
    };
  } catch {
    return { quality: "review" as const, rejected: false, reason: "质检暂时不可用", tags: normalizeGarmentAITags(null, { category, color }) };
  }
}

async function handlePOST(request: Request) {
  try {
    requireSession(request);
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
    const sourceBuffer = await image.arrayBuffer();
    const cacheHash = await productCacheKey(sourceBuffer, category, color);
    const cacheBase = `product-cache/v10/${cacheHash}`;
    try {
      const [cachedImage, cachedMetadata] = await Promise.all([
        storageGet(`${cacheBase}.image`),
        storageGet(`${cacheBase}.json`),
      ]);
      if (cachedImage && cachedMetadata) {
        const meta = JSON.parse(new TextDecoder().decode(cachedMetadata.body)) as CachedProduct;
        return productResponse(cachedImage.body, meta, "HIT");
      }
    } catch {
      // 缓存不可用则降级为直接生成
    }

    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const endpoint = getServerEnv("DASHSCOPE_IMAGE_ENDPOINT") || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
    const model = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_MODEL") || "qwen-image-2.0";
    const size = getServerEnv("DASHSCOPE_PRODUCT_IMAGE_SIZE") || "1536*1536";
    const imageData = `data:${image.type};base64,${toBase64(sourceBuffer)}`;

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
          negative_prompt: "人物，模特，人体，假人，皮肤，脖子，头发，脸，手，手指，手臂，脚，腿，躯干，袜子，其他衣物，其他配饰，背景，地面，家具，杂物，阴影，道具，衣架，额外商品，重复商品，虚构首饰，拉长，延长，改变长度，裁切，模糊，低清晰度，文字，水印，边框，变形，改变款式",
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
    if (validation.rejected) throw new Error(`商品图已拦截：${validation.reason}`);
    if (!generated.ok) throw new Error("高清商品图下载失败");
    const generatedBuffer = await generated.arrayBuffer();
    const meta: CachedProduct = {
      quality: validation.quality,
      tags: validation.tags,
      contentType: generated.headers.get("Content-Type") || "image/png",
    };
    try {
      await Promise.all([
        storagePut(`${cacheBase}.image`, generatedBuffer, meta.contentType),
        storagePut(`${cacheBase}.json`, Buffer.from(JSON.stringify(meta)), "application/json"),
      ]);
    } catch {
      // 缓存写入失败不影响本次返回
    }
    return productResponse(generatedBuffer, meta, "MISS");
  } catch (error) {
    const authResponse = responseForAuthError(error);
    if (authResponse) return authResponse;
    return apiErrorResponse(request, error, "高清商品图生成失败");
  }
}

export function POST(request: Request) {
  return withProtectedApiRequest(request, handlePOST, "高清商品图生成失败");
}
