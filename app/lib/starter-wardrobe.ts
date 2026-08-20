/**
 * 预设衣柜数据：女生/男生各一套真实单品（含完整 AI 标签）。
 * 图片由服务端用 qwen-image-2.0 生成真实白底商品图并缓存，前端只负责触发与展示。
 */

export type StarterCategory = "上衣" | "外套" | "下装" | "连衣裙" | "鞋履" | "配饰" | "帽子";

export type StarterGarment = {
  id: string;            // 全局唯一，形如 "female-top-knit"
  gender: "female" | "male";
  name: string;
  category: StarterCategory;
  colorName: string;
  colorHex: string;
  season: string;
  style: string;
  drawPrompt: string;    // 给 qwen-image-2.0 的商品图生成提示词
  aiTags: Record<string, unknown>;
};

const tagBase = {
  version: 2,
  material: "待补全",
  pattern: "纯色",
  fit: "常规",
  length: "常规",
  colorTone: "",
  colorFamily: "",
  colorTemperature: "中性",
  lightness: "中",
  saturation: "低",
  layer: "",
  silhouette: "常规",
  visualWeight: "中等",
  waistline: "不适用",
  rise: "不适用",
  legShape: "不适用",
  patternScale: "无",
  statementLevel: 1,
  role: "基础款",
  layering: [],
  warmth: 3,
  formality: 3,
  styles: ["简约"],
  occasions: ["通勤", "休闲"],
  seasons: ["四季"],
  weather: ["晴天"],
};

function garment(
  gender: "female" | "male",
  id: string,
  name: string,
  category: StarterCategory,
  colorName: string,
  colorHex: string,
  season: string,
  style: string,
  overrides: Partial<Record<string, unknown>>,
): StarterGarment {
  const drawPrompt = `${category} · ${colorName} · ${name}`;
  return { id, gender, name, category, colorName, colorHex, season, style, drawPrompt, aiTags: { ...tagBase, ...overrides } };
}

export const starterGarments: StarterGarment[] = [
  // ---------- 女生 12 件 ----------
  garment("female", "female-top-knit", "奶油白针织衫", "上衣", "米色", "#E8DFC8", "春秋", "简约", {
    subcategory: "针织衫", material: "针织", colorTone: "奶油白", colorFamily: "米色", colorTemperature: "暖色", lightness: "高", layer: "内搭", warmth: 3, formality: 3, styles: ["简约", "松弛感"], occasions: ["通勤", "休闲", "约会"], seasons: ["春秋"], weather: ["晴天"],
  }),
  garment("female", "female-top-shirt", "白色荷叶边衬衫", "上衣", "白色", "#F4F2EE", "四季", "通勤", {
    subcategory: "衬衫", material: "棉", colorTone: "白色", colorFamily: "白色", lightness: "高", layer: "内搭", statementLevel: 2, warmth: 2, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "正式活动"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("female", "female-outer-blazer", "燕麦色西装外套", "外套", "米色", "#D6C9AE", "四季", "通勤", {
    subcategory: "西装外套", material: "混纺", colorTone: "燕麦色", colorFamily: "米色", colorTemperature: "暖色", layer: "外层", statementLevel: 3, warmth: 3, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "正式活动"], seasons: ["春秋", "冬季"], weather: ["晴天", "多云"],
  }),
  garment("female", "female-outer-trench", "卡其色风衣", "外套", "卡其色", "#B59D78", "春秋", "通勤", {
    subcategory: "风衣", material: "聚酯纤维", colorTone: "卡其", colorFamily: "棕色", colorTemperature: "暖色", fit: "宽松", length: "中长", layer: "外层", statementLevel: 2, warmth: 3, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "约会"], seasons: ["春秋"], weather: ["多云", "有小雨"],
  }),
  garment("female", "female-pants-jeans", "浅蓝直筒牛仔裤", "下装", "蓝色", "#8FA7C4", "四季", "休闲", {
    subcategory: "牛仔裤", material: "牛仔", colorTone: "浅蓝", colorFamily: "蓝色", colorTemperature: "冷色", fit: "直筒", length: "长裤", layer: "下装", warmth: 3, formality: 2, styles: ["休闲", "简约"], occasions: ["休闲", "约会", "旅行"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("female", "female-pants-slacks", "炭灰高腰阔腿裤", "下装", "灰色", "#6E6E6E", "四季", "通勤", {
    subcategory: "阔腿裤", material: "羊毛混纺", colorTone: "炭灰", colorFamily: "灰色", fit: "宽松", length: "长裤", layer: "下装", waistline: "高腰", statementLevel: 2, warmth: 3, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "正式活动"], seasons: ["四季"], weather: ["晴天", "多云"],
  }),
  garment("female", "female-skirt-black", "黑色直筒半身裙", "下装", "黑色", "#33312E", "春秋", "约会", {
    subcategory: "半身裙", material: "针织", colorTone: "黑色", colorFamily: "黑色", fit: "直筒", length: "中裙", layer: "下装", statementLevel: 2, warmth: 3, formality: 3, styles: ["简约", "甜酷"], occasions: ["约会", "聚会", "通勤"], seasons: ["春秋"], weather: ["晴天"],
  }),
  garment("female", "female-dress-beige", "米色收腰连衣裙", "连衣裙", "米色", "#D9CBB0", "春秋", "约会", {
    subcategory: "收腰连衣裙", material: "雪纺", colorTone: "米色", colorFamily: "米色", colorTemperature: "暖色", fit: "修身", length: "中长", layer: "连体", statementLevel: 2, warmth: 2, formality: 3, styles: ["简约", "温柔"], occasions: ["约会", "聚会", "通勤"], seasons: ["春秋"], weather: ["晴天"],
  }),
  garment("female", "female-shoes-loafer", "焦糖乐福鞋", "鞋履", "棕色", "#8A5F3C", "春秋", "通勤", {
    subcategory: "乐福鞋", material: "皮革", colorTone: "焦糖", colorFamily: "棕色", colorTemperature: "暖色", length: "短", layer: "鞋履", statementLevel: 1, warmth: 2, formality: 3, styles: ["通勤", "轻复古"], occasions: ["通勤", "约会"], seasons: ["春秋"], weather: ["晴天"],
  }),
  garment("female", "female-shoes-heel", "米白粗跟玛丽珍鞋", "鞋履", "白色", "#EFE8DD", "春秋", "约会", {
    subcategory: "玛丽珍鞋", material: "皮革", colorTone: "米白", colorFamily: "白色", lightness: "高", length: "短", layer: "鞋履", statementLevel: 2, warmth: 2, formality: 3, styles: ["简约", "温柔"], occasions: ["约会", "聚会"], seasons: ["春秋"], weather: ["晴天"],
  }),
  garment("female", "female-bag-wine", "酒红腋下包", "配饰", "酒红色", "#6E3A45", "四季", "约会", {
    subcategory: "单肩包", material: "皮革", colorTone: "酒红", colorFamily: "红色", colorTemperature: "暖色", length: "短", layer: "配饰", statementLevel: 3, warmth: 1, formality: 3, styles: ["简约", "甜酷"], occasions: ["约会", "聚会", "通勤"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("female", "female-hat-beret", "黑色贝雷帽", "帽子", "黑色", "#2E2E2E", "秋冬", "文艺", {
    subcategory: "贝雷帽", material: "羊毛", colorTone: "黑色", colorFamily: "黑色", length: "短", layer: "配饰", statementLevel: 2, warmth: 2, formality: 2, styles: ["文艺", "轻复古"], occasions: ["约会", "休闲"], seasons: ["秋冬"], weather: ["晴天", "多云"],
  }),

  // ---------- 男生 12 件 ----------
  garment("male", "male-top-tshirt", "白色圆领T恤", "上衣", "白色", "#F2F1EE", "四季", "休闲", {
    subcategory: "T恤", material: "棉", colorTone: "白色", colorFamily: "白色", lightness: "高", layer: "内搭", warmth: 2, formality: 2, styles: ["休闲", "简约"], occasions: ["休闲", "运动", "旅行"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("male", "male-top-shirt", "浅蓝牛津衬衫", "上衣", "蓝色", "#A8BFD4", "四季", "通勤", {
    subcategory: "衬衫", material: "牛津纺", colorTone: "浅蓝", colorFamily: "蓝色", colorTemperature: "冷色", layer: "内搭", statementLevel: 1, warmth: 2, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "正式活动"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("male", "male-outer-suit", "藏青单排扣西装", "外套", "藏青色", "#2F3A52", "四季", "通勤", {
    subcategory: "西装外套", material: "羊毛混纺", colorTone: "藏青", colorFamily: "蓝色", colorTemperature: "冷色", layer: "外层", statementLevel: 4, warmth: 3, formality: 5, styles: ["通勤", "正式"], occasions: ["通勤", "正式活动", "商务"], seasons: ["春秋", "冬季"], weather: ["晴天", "多云"],
  }),
  garment("male", "male-outer-jacket", "军绿色工装夹克", "外套", "绿色", "#5B6651", "春秋", "休闲", {
    subcategory: "夹克", material: "棉", colorTone: "军绿", colorFamily: "绿色", fit: "宽松", layer: "外层", statementLevel: 3, warmth: 3, formality: 2, styles: ["休闲", "工装"], occasions: ["休闲", "旅行"], seasons: ["春秋"], weather: ["多云"],
  }),
  garment("male", "male-pants-jeans", "深蓝直筒牛仔裤", "下装", "蓝色", "#4A5E78", "四季", "休闲", {
    subcategory: "牛仔裤", material: "牛仔", colorTone: "深蓝", colorFamily: "蓝色", colorTemperature: "冷色", fit: "直筒", length: "长裤", layer: "下装", warmth: 3, formality: 2, styles: ["休闲", "简约"], occasions: ["休闲", "旅行", "运动"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("male", "male-pants-slacks", "炭灰修身西裤", "下装", "灰色", "#5F5F5F", "四季", "通勤", {
    subcategory: "西裤", material: "羊毛混纺", colorTone: "炭灰", colorFamily: "灰色", fit: "修身", length: "长裤", layer: "下装", waistline: "中腰", statementLevel: 2, warmth: 3, formality: 4, styles: ["通勤", "简约"], occasions: ["通勤", "正式活动"], seasons: ["四季"], weather: ["晴天", "多云"],
  }),
  garment("male", "male-pants-chino", "卡其休闲裤", "下装", "卡其色", "#B59D78", "四季", "休闲", {
    subcategory: "休闲裤", material: "斜纹棉", colorTone: "卡其", colorFamily: "棕色", colorTemperature: "暖色", fit: "直筒", length: "长裤", layer: "下装", warmth: 2, formality: 3, styles: ["休闲", "通勤"], occasions: ["休闲", "通勤", "旅行"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("male", "male-shoes-leather", "黑色德比皮鞋", "鞋履", "黑色", "#2B2B2B", "四季", "通勤", {
    subcategory: "德比鞋", material: "皮革", colorTone: "黑色", colorFamily: "黑色", length: "短", layer: "鞋履", statementLevel: 1, warmth: 2, formality: 4, styles: ["通勤", "正式"], occasions: ["通勤", "正式活动"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("male", "male-shoes-sneaker", "白色低帮运动鞋", "鞋履", "白色", "#F2F1EE", "四季", "运动", {
    subcategory: "运动鞋", material: "帆布", colorTone: "白色", colorFamily: "白色", lightness: "高", length: "短", layer: "鞋履", warmth: 2, formality: 1, styles: ["休闲", "运动"], occasions: ["休闲", "运动", "旅行"], seasons: ["四季"], weather: ["晴天"],
  }),
  garment("male", "male-shoes-loafers", "棕色乐福鞋", "鞋履", "棕色", "#7A5C3E", "春秋", "通勤", {
    subcategory: "乐福鞋", material: "皮革", colorTone: "棕色", colorFamily: "棕色", colorTemperature: "暖色", length: "短", layer: "鞋履", warmth: 2, formality: 3, styles: ["通勤", "轻复古"], occasions: ["通勤", "约会"], seasons: ["春秋"], weather: ["晴天"],
  }),
  garment("male", "male-bag-backpack", "黑色双肩包", "配饰", "黑色", "#2E2E2E", "四季", "通勤", {
    subcategory: "双肩包", material: "帆布", colorTone: "黑色", colorFamily: "黑色", length: "中", layer: "配饰", statementLevel: 1, warmth: 1, formality: 3, styles: ["通勤", "休闲"], occasions: ["通勤", "旅行", "运动"], seasons: ["四季"], weather: ["晴天", "多云"],
  }),
  garment("male", "male-hat-cap", "藏青棒球帽", "帽子", "藏青色", "#3A4661", "四季", "休闲", {
    subcategory: "棒球帽", material: "棉", colorTone: "藏青", colorFamily: "蓝色", colorTemperature: "冷色", length: "短", layer: "配饰", statementLevel: 2, warmth: 2, formality: 1, styles: ["休闲", "运动"], occasions: ["休闲", "旅行", "运动"], seasons: ["四季"], weather: ["晴天"],
  }),
];

export function starterGarmentsFor(gender: string | undefined): StarterGarment[] {
  const normalized = gender === "男" ? "male" : "female";
  return starterGarments.filter(item => item.gender === normalized);
}
