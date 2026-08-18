export type GarmentAITags = {
  version: 1;
  subcategory: string;
  material: string;
  pattern: string;
  fit: string;
  length: string;
  colorTone: string;
  layer: string;
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

export function normalizeGarmentAITags(value: unknown, fallback: { category: string; color: string; season?: string; style?: string }): GarmentAITags {
  const tags = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    version: 1,
    subcategory: shortText(tags.subcategory, fallback.category),
    material: shortText(tags.material, "待补全"),
    pattern: shortText(tags.pattern, "待补全"),
    fit: shortText(tags.fit, "常规"),
    length: shortText(tags.length, "常规"),
    colorTone: shortText(tags.colorTone, fallback.color),
    layer: shortText(tags.layer, defaultLayer(fallback.category)),
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
