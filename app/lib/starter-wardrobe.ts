import { normalizeGarmentAITags, type GarmentAITags } from "./garment-tags";

/**
 * 预设衣柜：首访用户不想逐件上传衣物时，一键把这一套预置单品放进衣柜。
 * 与真实上传的衣物完全同构（同一张表、同一个上传接口），可编辑、可删除、
 * 可参与推荐与试穿，用户随时可以换成自己的衣服。
 */

export type StarterGarment = {
  id: string;
  name: string;
  category: string;
  colorName: string;
  colorHex: string;
  season: string;
  style: string;
  draw: "top" | "outer" | "pants" | "skirt" | "dress" | "shoes" | "bag" | "hat";
  aiTags: GarmentAITags;
};

const tags = (overrides: Partial<GarmentAITags> & { category: string; color: string; season?: string; style?: string }): GarmentAITags =>
  normalizeGarmentAITags(overrides, { category: overrides.category, color: overrides.color, season: overrides.season || "四季", style: overrides.style || "简约" });

export const starterGarments: StarterGarment[] = [
  {
    id: "starter-top-knit",
    name: "奶油白针织衫",
    category: "上衣", colorName: "米色", colorHex: "#E8DFC8", season: "春秋", style: "简约", draw: "top",
    aiTags: tags({ category: "上衣", color: "米色", subcategory: "针织衫", material: "针织", pattern: "纯色", fit: "常规", length: "常规", colorTone: "奶油白", colorFamily: "米色", colorTemperature: "暖色", lightness: "高", saturation: "低", layer: "内搭", statementLevel: 1, role: "基础款", warmth: 3, formality: 3, styles: ["简约", "松弛感"], occasions: ["通勤", "休闲", "约会"], seasons: ["春秋"], weather: ["晴天"] }),
  },
  {
    id: "starter-top-shirt",
    name: "白色通勤衬衫",
    category: "上衣", colorName: "白色", colorHex: "#F4F2EE", season: "四季", style: "通勤", draw: "top",
    aiTags: tags({ category: "上衣", color: "白色", subcategory: "衬衫", material: "棉", pattern: "纯色", fit: "合身", length: "常规", colorTone: "白色", colorFamily: "白色", colorTemperature: "中性", lightness: "高", saturation: "低", layer: "内搭", statementLevel: 1, role: "基础款", warmth: 2, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "正式活动"], seasons: ["四季"], weather: ["晴天"] }),
  },
  {
    id: "starter-outer-blazer",
    name: "橄榄绿西装外套",
    category: "外套", colorName: "绿色", colorHex: "#5F6E52", season: "四季", style: "通勤", draw: "outer",
    aiTags: tags({ category: "外套", color: "绿色", subcategory: "西装外套", material: "混纺", pattern: "纯色", fit: "合身", length: "常规", colorTone: "橄榄绿", colorFamily: "绿色", colorTemperature: "中性", lightness: "低", saturation: "低", layer: "外层", statementLevel: 3, role: "外套", warmth: 3, formality: 4, styles: ["通勤", "轻复古"], occasions: ["通勤", "正式活动", "聚会"], seasons: ["春秋", "冬季"], weather: ["晴天", "多云"] }),
  },
  {
    id: "starter-outer-trench",
    name: "卡其色风衣",
    category: "外套", colorName: "卡其色", colorHex: "#B59D78", season: "春秋", style: "通勤", draw: "outer",
    aiTags: tags({ category: "外套", color: "卡其色", subcategory: "风衣", material: "聚酯纤维", pattern: "纯色", fit: "宽松", length: "中长", colorTone: "卡其", colorFamily: "棕色", colorTemperature: "暖色", lightness: "中", saturation: "低", layer: "外层", statementLevel: 2, role: "外套", warmth: 3, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "约会", "旅行"], seasons: ["春秋"], weather: ["多云", "有小雨"] }),
  },
  {
    id: "starter-pants-jeans",
    name: "浅蓝直筒牛仔裤",
    category: "下装", colorName: "蓝色", colorHex: "#8FA7C4", season: "四季", style: "休闲", draw: "pants",
    aiTags: tags({ category: "下装", color: "蓝色", subcategory: "牛仔裤", material: "牛仔", pattern: "纯色", fit: "直筒", length: "长裤", colorTone: "浅蓝", colorFamily: "蓝色", colorTemperature: "冷色", lightness: "中", saturation: "低", layer: "下装", statementLevel: 1, role: "基础款", warmth: 3, formality: 2, styles: ["休闲", "简约"], occasions: ["休闲", "约会", "旅行"], seasons: ["四季"], weather: ["晴天"] }),
  },
  {
    id: "starter-pants-slacks",
    name: "炭灰阔腿西裤",
    category: "下装", colorName: "灰色", colorHex: "#6E6E6E", season: "四季", style: "通勤", draw: "pants",
    aiTags: tags({ category: "下装", color: "灰色", subcategory: "阔腿裤", material: "羊毛混纺", pattern: "纯色", fit: "宽松", length: "长裤", colorTone: "炭灰", colorFamily: "灰色", colorTemperature: "中性", lightness: "低", saturation: "低", layer: "下装", statementLevel: 2, role: "基础款", warmth: 3, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "正式活动"], seasons: ["四季"], weather: ["晴天", "多云"] }),
  },
  {
    id: "starter-skirt-black",
    name: "黑色半身裙",
    category: "下装", colorName: "黑色", colorHex: "#33312E", season: "春秋", style: "约会", draw: "skirt",
    aiTags: tags({ category: "下装", color: "黑色", subcategory: "半身裙", material: "针织", pattern: "纯色", fit: "直筒", length: "中裙", colorTone: "黑色", colorFamily: "黑色", colorTemperature: "中性", lightness: "低", saturation: "低", layer: "下装", statementLevel: 2, role: "基础款", warmth: 3, formality: 3, styles: ["简约", "甜酷"], occasions: ["约会", "聚会", "通勤"], seasons: ["春秋"], weather: ["晴天"] }),
  },
  {
    id: "starter-shoes-loafer",
    name: "焦糖乐福鞋",
    category: "鞋履", colorName: "棕色", colorHex: "#8A5F3C", season: "春秋", style: "通勤", draw: "shoes",
    aiTags: tags({ category: "鞋履", color: "棕色", subcategory: "乐福鞋", material: "皮革", pattern: "纯色", fit: "常规", length: "短", colorTone: "焦糖", colorFamily: "棕色", colorTemperature: "暖色", lightness: "低", saturation: "中", layer: "鞋履", statementLevel: 1, role: "基础款", warmth: 2, formality: 3, styles: ["通勤", "轻复古"], occasions: ["通勤", "约会"], seasons: ["春秋"], weather: ["晴天"] }),
  },
  {
    id: "starter-shoes-sneaker",
    name: "白色运动鞋",
    category: "鞋履", colorName: "白色", colorHex: "#F2F1EE", season: "四季", style: "运动", draw: "shoes",
    aiTags: tags({ category: "鞋履", color: "白色", subcategory: "运动鞋", material: "帆布", pattern: "纯色", fit: "常规", length: "短", colorTone: "白色", colorFamily: "白色", colorTemperature: "中性", lightness: "高", saturation: "低", layer: "鞋履", statementLevel: 1, role: "基础款", warmth: 2, formality: 1, styles: ["休闲", "运动"], occasions: ["休闲", "运动", "旅行"], seasons: ["四季"], weather: ["晴天"] }),
  },
  {
    id: "starter-bag-wine",
    name: "酒红腋下包",
    category: "配饰", colorName: "酒红色", colorHex: "#6E3A45", season: "四季", style: "约会", draw: "bag",
    aiTags: tags({ category: "配饰", color: "酒红", subcategory: "单肩包", material: "皮革", pattern: "纯色", fit: "常规", length: "短", colorTone: "酒红", colorFamily: "红色", colorTemperature: "暖色", lightness: "低", saturation: "中", layer: "配饰", statementLevel: 3, role: "配饰", warmth: 1, formality: 3, styles: ["简约", "甜酷"], occasions: ["约会", "聚会", "通勤"], seasons: ["四季"], weather: ["晴天"] }),
  },
  {
    id: "starter-dress-beige",
    name: "米色收腰连衣裙",
    category: "连衣裙", colorName: "米色", colorHex: "#D9CBB0", season: "春秋", style: "约会", draw: "dress",
    aiTags: tags({ category: "连衣裙", color: "米色", subcategory: "收腰连衣裙", material: "雪纺", pattern: "纯色", fit: "修身", length: "中长", colorTone: "米色", colorFamily: "米色", colorTemperature: "暖色", lightness: "中", saturation: "低", layer: "连体", statementLevel: 2, role: "连衣裙", warmth: 2, formality: 3, styles: ["简约", "温柔"], occasions: ["约会", "聚会", "通勤"], seasons: ["春秋"], weather: ["晴天"] }),
  },
  {
    id: "starter-hat-black",
    name: "黑色棒球帽",
    category: "帽子", colorName: "黑色", colorHex: "#2E2E2E", season: "四季", style: "休闲", draw: "hat",
    aiTags: tags({ category: "帽子", color: "黑色", subcategory: "棒球帽", material: "棉", pattern: "纯色", fit: "常规", length: "短", colorTone: "黑色", colorFamily: "黑色", colorTemperature: "中性", lightness: "低", saturation: "低", layer: "配饰", statementLevel: 2, role: "配饰", warmth: 2, formality: 1, styles: ["休闲", "运动"], occasions: ["休闲", "旅行", "运动"], seasons: ["四季"], weather: ["晴天"] }),
  },
];

const paletteCache = new Map<string, string[]>();
function shade(hex: string, offset: number) {
  const cached = paletteCache.get(hex);
  if (cached) return cached[offset < 0 ? 0 : 2];
  const value = hex.replace("#", "");
  const number = Number.parseInt(value.length === 3 ? value.split("").map(char => char + char).join("") : value, 16);
  const r = (number >> 16) & 255;
  const g = (number >> 8) & 255;
  const b = number & 255;
  const light = `rgb(${Math.min(255, Math.round(r + (255 - r) * 0.28))},${Math.min(255, Math.round(g + (255 - g) * 0.28))},${Math.min(255, Math.round(b + (255 - b) * 0.28))})`;
  const dark = `rgb(${Math.round(r * 0.72)},${Math.round(g * 0.72)},${Math.round(b * 0.72)})`;
  paletteCache.set(hex, [light, hex, dark]);
  return offset < 0 ? light : offset > 0 ? dark : hex;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + w, y, x + w, y + h, r);
  context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r);
  context.arcTo(x, y, x + w, y, r);
  context.closePath();
}

function drawTop(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  // 衣身
  roundedRect(context, 186, 200, 140, 230, 26);
  context.fill();
  // 袖子
  context.beginPath();
  context.moveTo(190, 215);
  context.quadraticCurveTo(118, 232, 118, 300);
  context.lineTo(150, 310);
  context.quadraticCurveTo(158, 250, 196, 250);
  context.closePath();
  context.fill();
  context.beginPath();
  context.moveTo(322, 215);
  context.quadraticCurveTo(394, 232, 394, 300);
  context.lineTo(362, 310);
  context.quadraticCurveTo(354, 250, 316, 250);
  context.closePath();
  context.fill();
  // 领口
  context.fillStyle = shade(hex, 1);
  context.beginPath();
  context.moveTo(226, 200);
  context.lineTo(256, 240);
  context.lineTo(286, 200);
  context.closePath();
  context.fill();
  // 下摆缝线
  context.strokeStyle = dark;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(196, 418);
  context.lineTo(316, 418);
  context.stroke();
}

function drawOuter(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const light = shade(hex, -1);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  roundedRect(context, 176, 176, 160, 260, 22);
  context.fill();
  // 衣身开襟中线
  context.fillStyle = light;
  context.fillRect(252, 190, 8, 246);
  // 翻领
  context.fillStyle = dark;
  context.beginPath();
  context.moveTo(196, 188);
  context.lineTo(252, 218);
  context.lineTo(220, 246);
  context.closePath();
  context.fill();
  context.beginPath();
  context.moveTo(316, 188);
  context.lineTo(260, 218);
  context.lineTo(292, 246);
  context.closePath();
  context.fill();
  // 口袋
  roundedRect(context, 206, 330, 34, 30, 6);
  context.fillStyle = body;
  context.fill();
  context.strokeStyle = dark;
  context.lineWidth = 2.5;
  context.stroke();
  roundedRect(context, 272, 330, 34, 30, 6);
  context.fillStyle = body;
  context.fill();
  context.stroke();
  // 腰带扣
  context.fillStyle = dark;
  roundedRect(context, 246, 258, 20, 14, 4);
  context.fill();
}

function drawPants(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  // 腰头
  roundedRect(context, 190, 170, 132, 44, 12);
  context.fill();
  // 两条裤腿
  context.beginPath();
  context.moveTo(196, 214);
  context.lineTo(236, 214);
  context.lineTo(224, 420);
  context.lineTo(176, 420);
  context.closePath();
  context.fill();
  context.beginPath();
  context.moveTo(276, 214);
  context.lineTo(316, 214);
  context.lineTo(336, 420);
  context.lineTo(288, 420);
  context.closePath();
  context.fill();
  // 裤缝
  context.strokeStyle = dark;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(240, 224);
  context.lineTo(226, 416);
  context.moveTo(272, 224);
  context.lineTo(286, 416);
  context.stroke();
  // 门襟
  context.fillStyle = dark;
  context.fillRect(252, 176, 8, 30);
}

function drawSkirt(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  // 腰头
  roundedRect(context, 210, 150, 92, 30, 8);
  context.fill();
  // 裙摆 A 字
  context.beginPath();
  context.moveTo(216, 180);
  context.lineTo(296, 180);
  context.lineTo(332, 400);
  context.lineTo(180, 400);
  context.closePath();
  context.fill();
  // 裙褶线
  context.strokeStyle = dark;
  context.lineWidth = 2.5;
  context.beginPath();
  context.moveTo(226, 190);
  context.lineTo(214, 392);
  context.moveTo(286, 190);
  context.lineTo(298, 392);
  context.stroke();
}

function drawDress(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  // 上身
  roundedRect(context, 206, 168, 100, 96, 22);
  context.fill();
  // 袖子
  context.beginPath();
  context.moveTo(208, 182);
  context.quadraticCurveTo(150, 198, 150, 248);
  context.lineTo(180, 256);
  context.quadraticCurveTo(186, 210, 212, 212);
  context.closePath();
  context.fill();
  context.beginPath();
  context.moveTo(304, 182);
  context.quadraticCurveTo(362, 198, 362, 248);
  context.lineTo(332, 256);
  context.quadraticCurveTo(326, 210, 300, 212);
  context.closePath();
  context.fill();
  // 裙摆
  context.beginPath();
  context.moveTo(214, 264);
  context.lineTo(298, 264);
  context.lineTo(336, 410);
  context.lineTo(176, 410);
  context.closePath();
  context.fill();
  // 领口
  context.fillStyle = dark;
  context.beginPath();
  context.moveTo(230, 172);
  context.lineTo(256, 204);
  context.lineTo(282, 172);
  context.closePath();
  context.fill();
  // 腰线
  context.strokeStyle = dark;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(216, 262);
  context.lineTo(296, 262);
  context.stroke();
}

function drawShoes(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  // 鞋底
  roundedRect(context, 130, 330, 252, 34, 16);
  context.fill();
  // 鞋身
  context.beginPath();
  context.moveTo(150, 332);
  context.quadraticCurveTo(140, 260, 196, 252);
  context.lineTo(330, 252);
  context.quadraticCurveTo(372, 258, 370, 310);
  context.lineTo(370, 332);
  context.closePath();
  context.fill();
  // 鞋口
  context.fillStyle = dark;
  context.beginPath();
  context.moveTo(212, 258);
  context.quadraticCurveTo(262, 268, 322, 262);
  context.lineTo(316, 286);
  context.quadraticCurveTo(262, 292, 208, 284);
  context.closePath();
  context.fill();
}

function drawBag(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  // 包身
  roundedRect(context, 176, 250, 160, 120, 26);
  context.fill();
  // 手柄
  context.strokeStyle = dark;
  context.lineWidth = 14;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(206, 258);
  context.quadraticCurveTo(256, 168, 306, 258);
  context.stroke();
  // 盖扣
  context.fillStyle = dark;
  context.beginPath();
  context.arc(256, 310, 9, 0, Math.PI * 2);
  context.fill();
}

function drawHat(context: CanvasRenderingContext2D, hex: string) {
  const body = shade(hex, 0);
  const dark = shade(hex, 1);
  context.fillStyle = body;
  // 帽冠
  context.beginPath();
  context.moveTo(220, 230);
  context.quadraticCurveTo(256, 148, 292, 230);
  context.lineTo(286, 268);
  context.quadraticCurveTo(256, 250, 226, 268);
  context.closePath();
  context.fill();
  // 帽檐
  roundedRect(context, 176, 268, 160, 34, 17);
  context.fill();
  // 帽檐缝线
  context.strokeStyle = dark;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(186, 284);
  context.lineTo(326, 284);
  context.stroke();
}

function drawStarterGarment(canvas: HTMLCanvasElement, item: StarterGarment) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法绘制预设衣物");
  canvas.width = 512;
  canvas.height = 512;
  context.fillStyle = "#FFFFFF";
  context.fillRect(0, 0, 512, 512);
  // 底部柔和阴影
  context.fillStyle = "rgba(0,0,0,0.06)";
  context.beginPath();
  context.ellipse(256, 440, 168, 22, 0, 0, Math.PI * 2);
  context.fill();
  const draw = item.draw === "top" ? drawTop : item.draw === "outer" ? drawOuter : item.draw === "pants" ? drawPants : item.draw === "skirt" ? drawSkirt : item.draw === "dress" ? drawDress : item.draw === "shoes" ? drawShoes : item.draw === "bag" ? drawBag : drawHat;
  draw(context, item.colorHex);
}

export function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("预设衣物图片生成失败")), "image/png", 0.95));
}

export async function renderStarterGarment(item: StarterGarment) {
  const canvas = document.createElement("canvas");
  drawStarterGarment(canvas, item);
  return canvasToPngBlob(canvas);
}
