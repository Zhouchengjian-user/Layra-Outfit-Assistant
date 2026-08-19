export type GarmentAITags = {
  version: 2;
  subcategory: string;
  material: string;
  pattern: string;
  fit: string;
  length: string;
  colorTone: string;
  colorFamily: string;
  colorTemperature: string;
  lightness: string;
  saturation: string;
  layer: string;
  silhouette: string;
  visualWeight: string;
  waistline: string;
  rise: string;
  legShape: string;
  patternScale: string;
  statementLevel: number;
  role: string;
  layering: string[];
  warmth: number;
  formality: number;
  styles: string[];
  occasions: string[];
  seasons: string[];
  weather: string[];
};

function shortText(value: unknown, fallback: string) {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, 16);
}

function shortList(value: unknown, fallback: string[] = []) {
  const source = Array.isArray(value) && value.length ? value : fallback;
  return [...new Set(source.map(item => String(item || "").trim()).filter(Boolean))].slice(0, 5).map(item => item.slice(0, 12));
}

function score(value: unknown, fallback = 3) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.max(1, Math.min(5, number)) : fallback;
}

function defaultLayer(category: string) {
  if (category === "外套") return "外层";
  if (["裤子", "裙子", "下装"].includes(category)) return "下装";
  if (category === "连衣裙") return "连体";
  if (["鞋子", "鞋履"].includes(category)) return "鞋履";
  if (["腰带", "包", "帽子", "首饰", "其他配饰", "配饰"].includes(category)) return "配饰";
  return "内搭";
}

function colorFamily(value: string) {
  const color = value.toLowerCase();
  const groups: Array<[string, string[]]> = [
    ["黑色", ["黑", "black", "墨"]], ["白色", ["白", "white", "奶油"]], ["灰色", ["灰", "grey", "gray", "炭"]],
    ["蓝色", ["蓝", "blue", "牛仔"]], ["红色", ["红", "red", "酒红", "粉"]], ["绿色", ["绿", "green", "橄榄"]],
    ["黄色", ["黄", "yellow", "金"]], ["棕色", ["棕", "brown", "焦糖", "咖", "驼"]], ["紫色", ["紫", "purple"]],
    ["米色", ["米", "beige", "cream", "卡其"]],
  ];
  return groups.find(([, keywords]) => keywords.some(keyword => color.includes(keyword)))?.[0] || "其他";
}

function colorTemperature(family: string) {
  if (["红色", "黄色", "棕色", "米色"].includes(family)) return "暖色";
  if (["蓝色", "绿色", "紫色"].includes(family)) return "冷色";
  return "中性";
}

export function normalizeGarmentAITags(value: unknown, fallback: { category: string; color: string; season?: string; style?: string }): GarmentAITags {
  const tags = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const fallbackFamily = colorFamily(fallback.color);
  return {
    version: 2,
    subcategory: shortText(tags.subcategory, fallback.category),
    material: shortText(tags.material, "待补全"),
    pattern: shortText(tags.pattern, "待补全"),
    fit: shortText(tags.fit, "常规"),
    length: shortText(tags.length, "常规"),
    colorTone: shortText(tags.colorTone, fallback.color),
    colorFamily: shortText(tags.colorFamily, fallbackFamily),
    colorTemperature: shortText(tags.colorTemperature, colorTemperature(fallbackFamily)),
    lightness: shortText(tags.lightness, "中"),
    saturation: shortText(tags.saturation, "中"),
    layer: shortText(tags.layer, defaultLayer(fallback.category)),
    silhouette: shortText(tags.silhouette, String(tags.fit || "常规")),
    visualWeight: shortText(tags.visualWeight, "中等"),
    waistline: shortText(tags.waistline, "不适用"),
    rise: shortText(tags.rise, "不适用"),
    legShape: shortText(tags.legShape, "不适用"),
    patternScale: shortText(tags.patternScale, String(tags.pattern || "").includes("纯色") ? "无" : "中"),
    statementLevel: score(tags.statementLevel, 2),
    role: shortText(tags.role, "基础款"),
    layering: shortList(tags.layering),
    warmth: score(tags.warmth),
    formality: score(tags.formality),
    styles: shortList(tags.styles, fallback.style ? [fallback.style] : []),
    occasions: shortList(tags.occasions),
    seasons: shortList(tags.seasons, fallback.season ? [fallback.season] : []),
    weather: shortList(tags.weather),
  };
}

export function garmentTagLabels(tags: GarmentAITags) {
  return [...new Set([
    tags.subcategory,
    tags.material,
    tags.pattern,
    tags.fit,
    tags.length,
    tags.silhouette,
    tags.visualWeight,
    tags.role,
    tags.layer,
    ...tags.styles,
    ...tags.occasions,
    ...tags.seasons,
    ...tags.weather,
  ])].filter(value => value && value !== "待补全" && value !== "常规");
}

export function encodeGarmentTags(tags: GarmentAITags) {
  const bytes = new TextEncoder().encode(JSON.stringify(tags));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeGarmentTags(value: string | null, fallback: { category: string; color: string; season?: string; style?: string }) {
  if (!value) return normalizeGarmentAITags(null, fallback);
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    return normalizeGarmentAITags(JSON.parse(new TextDecoder().decode(bytes)), fallback);
  } catch {
    return normalizeGarmentAITags(null, fallback);
  }
}
