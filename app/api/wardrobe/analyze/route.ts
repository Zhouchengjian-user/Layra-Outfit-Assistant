import { requireServerEnv, getServerEnv } from "../../../lib/server-env";

type Detection = {
  id: number;
  category: string;
  color: string;
  bbox_2d: [number, number, number, number];
  partially_occluded: boolean;
  recommended_api: "SegmentCloth" | "SegmentCommodity";
};

const allowedCategories = new Set(["上衣", "外套", "裤子", "裙子", "连衣裙", "鞋子", "帽子", "包", "首饰", "其他配饰"]);

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
      const horizontalGap = Math.max(0, Math.max(x1, cx1) - Math.min(x2, cx2));
      return verticalOverlap / minHeight > 0.45 && horizontalGap < 220;
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
    const commodity = ["鞋子", "帽子", "包", "首饰", "其他配饰"].includes(category);
    return [{
      id: Number(item.id) || index + 1,
      category,
      color: normalizeColor(item.color),
      bbox_2d: [x1, y1, x2, y2],
      partially_occluded: Boolean(item.partially_occluded),
      recommended_api: commodity ? "SegmentCommodity" : "SegmentCloth",
    }];
  });
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
识别图片中所有独立穿戴单品。类别只能为：上衣、外套、裤子、裙子、连衣裙、鞋子、帽子、包、首饰、其他配饰。
同类但完全独立的衣物要逐件输出；一双鞋、一对耳环视为一件，bbox 包含整双/整对。
bbox_2d 必须使用 0到1000 归一化坐标，格式为 [xmin,ymin,xmax,ymax]。
衣物 recommended_api 为 SegmentCloth，鞋帽包首饰为 SegmentCommodity。
只返回严格 JSON 数组，每项包含 id、category、color、bbox_2d、partially_occluded、recommended_api，不要解释。`;

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
    const detections = mergePairs(cleanDetections(parseJsonContent(content)));
    if (!detections.length) throw new Error("没有识别到可入柜的单品");
    return Response.json({ detections });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "单品识别失败" }, { status: 500 });
  }
}
