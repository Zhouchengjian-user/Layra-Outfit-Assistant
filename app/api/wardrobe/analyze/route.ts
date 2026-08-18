import { requireServerEnv, getServerEnv } from "../../../lib/server-env";

type Detection = {
  id: number;
  category: string;
  color: string;
  bbox_2d: [number, number, number, number];
  partially_occluded: boolean;
  recommended_api: "SegmentCloth" | "SegmentCommodity";
  confidence?: number;
  visible_ratio?: number;
};

const allowedCategories = new Set(["上衣", "外套", "裤子", "裙子", "连衣裙", "鞋子", "帽子", "腰带", "包", "首饰", "其他配饰"]);

const colorAliases: Record<string, string> = {
  white: "白色", black: "黑色", grey: "灰色", gray: "灰色", blue: "蓝色",
  navy: "藏青色", green: "绿色", red: "红色", pink: "粉色", purple: "紫色",
  yellow: "黄色", orange: "橙色", brown: "棕色", beige: "米色", khaki: "卡其色",
  silver: "银色", gold: "金色", cream: "奶油色",
};

function normalizeColor(value: unknown) {
  const color = String(value || "未识别").trim().toLowerCase();
  return (colorAliases[color] || color).slice(0, 16);
}

function mergePairs(items: Detection[]) {
  const consumed = new Set<number>();
  const merged: Detection[] = [];
  for (let index = 0; index < items.length; index++) {
    if (consumed.has(index)) continue;
    const item = items[index];
    if (!["鞋子", "首饰"].includes(item.category)) {
      merged.push(item);
      continue;
    }
    const [x1, y1, x2, y2] = item.bbox_2d;
    const matchIndex = items.findIndex((candidate, candidateIndex) => {
      if (candidateIndex <= index || consumed.has(candidateIndex) || candidate.category !== item.category) return false;
      const [cx1, cy1, cx2, cy2] = candidate.bbox_2d;
      const verticalOverlap = Math.max(0, Math.min(y2, cy2) - Math.max(y1, cy1));
      const minHeight = Math.max(1, Math.min(y2 - y1, cy2 - cy1));
      const maxHeight = Math.max(y2 - y1, cy2 - cy1);
      const centerYDistance = Math.abs((y1 + y2) / 2 - (cy1 + cy2) / 2);
      const horizontalGap = Math.max(0, Math.max(x1, cx1) - Math.min(x2, cx2));
      return horizontalGap < 300 && (verticalOverlap / minHeight > 0.18 || centerYDistance < maxHeight * 0.65);
    });
    if (matchIndex < 0) {
      merged.push(item);
      continue;
    }
    consumed.add(matchIndex);
    const pair = items[matchIndex];
    merged.push({
      ...item,
      bbox_2d: [
        Math.min(item.bbox_2d[0], pair.bbox_2d[0]),
        Math.min(item.bbox_2d[1], pair.bbox_2d[1]),
        Math.max(item.bbox_2d[2], pair.bbox_2d[2]),
        Math.max(item.bbox_2d[3], pair.bbox_2d[3]),
      ],
      partially_occluded: item.partially_occluded || pair.partially_occluded,
    });
  }
  return merged.map((item, index) => ({ ...item, id: index + 1 }));
}

function toBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function parseJsonContent(content: string) {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("模型未返回单品列表");
  return JSON.parse(stripped.slice(start, end + 1)) as unknown[];
}

async function requestDetections(baseUrl: string, apiKey: string, model: string, imageData: string, prompt: string) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      enable_thinking: false,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageData } },
        { type: "text", text: prompt },
      ] }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const message = (payload.error as Record<string, unknown> | undefined)?.message;
    throw new Error(typeof message === "string" ? message : "单品识别失败");
  }
  const choices = payload.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (!content) throw new Error("模型未返回识别结果");
  return cleanDetections(parseJsonContent(content));
}

function cleanDetections(value: unknown[]) {
  return value.slice(0, 20).flatMap((entry, index): Detection[] => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const rawBox = Array.isArray(item.bbox_2d) ? item.bbox_2d.map(Number) : [];
    if (rawBox.length !== 4 || rawBox.some(number => !Number.isFinite(number))) return [];
    let [x1, y1, x2, y2] = rawBox;
    x1 = Math.max(0, Math.min(1000, Math.round(x1)));
    y1 = Math.max(0, Math.min(1000, Math.round(y1)));
    x2 = Math.max(0, Math.min(1000, Math.round(x2)));
    y2 = Math.max(0, Math.min(1000, Math.round(y2)));
    if (x2 - x1 < 12 || y2 - y1 < 12) return [];
    const category = allowedCategories.has(String(item.category)) ? String(item.category) : "其他配饰";
    const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0.74));
    const visibleRatio = Math.max(0, Math.min(1, Number(item.visible_ratio) || 0.7));
    const boxArea = (x2 - x1) * (y2 - y1);
    const smallAccessory = ["首饰", "其他配饰"].includes(category);
    const footwear = category === "鞋子";
    const wearableAccessory = ["帽子", "腰带"].includes(category);
    if (confidence < (smallAccessory ? 0.86 : footwear ? 0.56 : wearableAccessory ? 0.6 : 0.66)) return [];
    if (visibleRatio < (smallAccessory ? 0.62 : footwear ? 0.4 : wearableAccessory ? 0.35 : 0.5)) return [];
    if (Boolean(item.partially_occluded) && visibleRatio < (smallAccessory ? 0.76 : footwear ? 0.52 : wearableAccessory ? 0.45 : 0.68)) return [];
    if (boxArea < (smallAccessory ? 4_500 : footwear ? 5_000 : wearableAccessory ? 2_500 : 10_000)) return [];
    const commodity = ["鞋子", "帽子", "腰带", "包", "首饰", "其他配饰"].includes(category);
    return [{
      id: Number(item.id) || index + 1,
      category,
      color: normalizeColor(item.color),
      bbox_2d: [x1, y1, x2, y2],
      partially_occluded: Boolean(item.partially_occluded),
      recommended_api: commodity ? "SegmentCommodity" : "SegmentCloth",
      confidence,
      visible_ratio: visibleRatio,
    }];
  });
}

function intersectionRatio(item: Detection, cover: Detection) {
  const [x1, y1, x2, y2] = item.bbox_2d;
  const [cx1, cy1, cx2, cy2] = cover.bbox_2d;
  const intersection = Math.max(0, Math.min(x2, cx2) - Math.max(x1, cx1)) * Math.max(0, Math.min(y2, cy2) - Math.max(y1, cy1));
  return intersection / Math.max(1, (x2 - x1) * (y2 - y1));
}

function removeItemsHiddenByOuterwear(items: Detection[]) {
  const outerwear = items.filter(item => item.category === "外套");
  if (!outerwear.length) return items;
  return items.filter(item => {
    if (!["上衣", "裤子", "裙子", "连衣裙"].includes(item.category)) return true;
    const coveredRatio = Math.max(0, ...outerwear.map(cover => intersectionRatio(item, cover)));
    return coveredRatio < 0.52;
  });
}

function boxIou(a: Detection, b: Detection) {
  const [x1, y1, x2, y2] = a.bbox_2d;
  const [bx1, by1, bx2, by2] = b.bbox_2d;
  const intersection = Math.max(0, Math.min(x2, bx2) - Math.max(x1, bx1)) * Math.max(0, Math.min(y2, by2) - Math.max(y1, by1));
  const union = (x2 - x1) * (y2 - y1) + (bx2 - bx1) * (by2 - by1) - intersection;
  return intersection / Math.max(1, union);
}

function boxArea(item: Detection) {
  const [x1, y1, x2, y2] = item.bbox_2d;
  return Math.max(1, (x2 - x1) * (y2 - y1));
}

function overlapOfSmaller(a: Detection, b: Detection) {
  const [x1, y1, x2, y2] = a.bbox_2d;
  const [bx1, by1, bx2, by2] = b.bbox_2d;
  const intersection = Math.max(0, Math.min(x2, bx2) - Math.max(x1, bx1)) * Math.max(0, Math.min(y2, by2) - Math.max(y1, by1));
  return intersection / Math.min(boxArea(a), boxArea(b));
}

function isSameFootwearObject(a: Detection, b: Detection) {
  return a.category === "鞋子" && b.category === "鞋子" && (boxIou(a, b) > 0.12 || overlapOfSmaller(a, b) > 0.28);
}

function mergeDetectionBoxes(a: Detection, b: Detection): Detection {
  return {
    ...a,
    color: a.color === "未识别" ? b.color : a.color,
    bbox_2d: [
      Math.min(a.bbox_2d[0], b.bbox_2d[0]),
      Math.min(a.bbox_2d[1], b.bbox_2d[1]),
      Math.max(a.bbox_2d[2], b.bbox_2d[2]),
      Math.max(a.bbox_2d[3], b.bbox_2d[3]),
    ],
    partially_occluded: a.partially_occluded || b.partially_occluded,
    confidence: Math.max(a.confidence || 0, b.confidence || 0),
    visible_ratio: Math.max(a.visible_ratio || 0, b.visible_ratio || 0),
  };
}

function deduplicateShoes(items: Detection[]) {
  const shoes = items.filter(item => item.category === "鞋子").sort((a, b) => boxArea(b) - boxArea(a));
  const uniqueShoes: Detection[] = [];
  for (const shoe of shoes) {
    const matchIndex = uniqueShoes.findIndex(candidate => isSameFootwearObject(candidate, shoe));
    if (matchIndex < 0) uniqueShoes.push(shoe);
    else uniqueShoes[matchIndex] = mergeDetectionBoxes(uniqueShoes[matchIndex], shoe);
  }
  return [...items.filter(item => item.category !== "鞋子"), ...uniqueShoes];
}

function isSameFocusedAccessory(a: Detection, b: Detection) {
  if (a.category !== b.category) return false;
  return a.category === "鞋子" ? isSameFootwearObject(a, b) : boxIou(a, b) > 0.2 || overlapOfSmaller(a, b) > 0.55;
}

function addMissingFocusedItems(items: Detection[], focusedItems: Detection[]) {
  const merged = [...items];
  for (const focusedItem of focusedItems.filter(item => ["鞋子", "帽子", "腰带"].includes(item.category))) {
    if (!merged.some(item => isSameFocusedAccessory(item, focusedItem))) merged.push(focusedItem);
  }
  return deduplicateShoes(merged);
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const image = form.get("image");
    if (!(image instanceof File) || !image.type.startsWith("image/")) {
      return Response.json({ error: "请上传需要识别的衣物照片" }, { status: 400 });
    }
    if (image.size > 6 * 1024 * 1024) {
      return Response.json({ error: "识别图片不能超过 6MB" }, { status: 400 });
    }

    const apiKey = requireServerEnv("DASHSCOPE_API_KEY");
    const baseUrl = (getServerEnv("DASHSCOPE_BASE_URL") || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
    const model = getServerEnv("DASHSCOPE_VISION_MODEL") || "qwen3-vl-flash";
    const imageData = `data:${image.type};base64,${toBase64(await image.arrayBuffer())}`;
    const prompt = `
你是服饰入库质检员。只识别照片中真实、清晰可见且可单独入柜的穿戴单品，禁止根据穿搭常识猜测被遮住或不存在的物品。
类别只能为：上衣、外套、裤子、裙子、连衣裙、鞋子、帽子、腰带、包、首饰、其他配饰。

边界要求：
1. 上衣/外套 bbox 只包服装本身，到衣摆为止，不包含头、颈部皮肤、手、裤子或裙子。
2. 裤子/裙子 bbox 只包下装本身，到裤脚/裙摆为止，不包含上衣、皮带装饰、脚、袜子或鞋。
3. 鞋子 bbox 包含同一双鞋，但不包含脚、袜子和裤脚；一双鞋视为一件。
4. 独立佩戴、具有完整带身和扣头的腰带输出为腰带；只有腰带扣、裤腰、衣服自带系带、衬衫打结或服装装饰带时不要输出腰带。花纹、盘扣和衣服上的装饰图案不是首饰。
5. 同类但完全独立的衣物逐件输出；不要把上下装合成一件，也不要重复输出高度重叠的同一单品。
6. 若某件内搭或下装被长外套遮住超过一半，只露出局部边缘、开衩或下摆，无法判断完整轮廓和版型，则不要输出该单品。宁可少识别，也绝不根据局部颜色脑补完整衣物。

bbox_2d 使用 0到1000 归一化坐标，格式为 [xmin,ymin,xmax,ymax]，尽量贴合物品轮廓且保留约1%安全边距。
confidence 为识别置信度 0到1；visible_ratio 为该单品可见完整度 0到1。看不清或 confidence 低于0.7的普通单品不要输出；首饰和其他配饰低于0.86不要输出。
衣物 recommended_api 为 SegmentCloth，鞋帽腰带包首饰为 SegmentCommodity。
只返回严格 JSON 数组，每项包含 id、category、color、bbox_2d、partially_occluded、confidence、visible_ratio、recommended_api，不要解释。`;
    const focusedAccessoryPrompt = `
只复核照片中真实可见的帽子、腰带和鞋子，不要输出衣服、裤子、包、手机、手表或首饰。
1. 帽子：只框独立帽体，不包含头、脸和头发；棒球帽、针织帽、礼帽均可。即使位于画面顶部且面积较小也要检查。
2. 腰带：必须看到独立带身沿腰部延伸并有真实扣头，只框腰带本身；裤腰、衬衫下摆打结、衣服自带系带或只有扣头时不要输出。
3. 鞋子：仔细检查画面底部人物脚部；一双鞋视为一件，bbox 尽量同时包住左右两只鞋，不包含小腿、袜子、地面或裤脚。模型若只能分别框左右鞋也可以逐只输出，系统会合并。
bbox_2d 使用0到1000归一化坐标。只返回严格JSON数组，每项包含 id、category（只能是帽子、腰带、鞋子）、color、bbox_2d、partially_occluded、confidence、visible_ratio、recommended_api:"SegmentCommodity"。没有则返回[]。`;

    const [generalResult, focusedResult] = await Promise.allSettled([
      requestDetections(baseUrl, apiKey, model, imageData, prompt),
      requestDetections(baseUrl, apiKey, model, imageData, focusedAccessoryPrompt),
    ]);
    const general = generalResult.status === "fulfilled" ? generalResult.value : [];
    const focusedItems = focusedResult.status === "fulfilled" ? focusedResult.value : [];
    if (!general.length && !focusedItems.length) throw generalResult.status === "rejected" ? generalResult.reason : new Error("没有识别到可入柜的单品");
    const detections = mergePairs(removeItemsHiddenByOuterwear(addMissingFocusedItems(general, focusedItems)));
    if (!detections.length) throw new Error("没有识别到可入柜的单品");
    return Response.json({ detections });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "单品识别失败" }, { status: 500 });
  }
}
