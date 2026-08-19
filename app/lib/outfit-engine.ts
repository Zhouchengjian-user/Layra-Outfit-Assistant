import { normalizeGarmentAITags, type GarmentAITags } from "./garment-tags";

export type StyleIntensity = "稳妥耐看" | "有点风格" | "大胆一点";

export type WardrobeMatchItem = {
  id: string;
  name: string;
  category: string;
  colorName: string;
  season: string;
  style: string;
  aiTags: GarmentAITags;
};

export type StylingIntent = {
  occasion: string;
  styles: string[];
  warmth: number;
  formality: number;
  colorPreference: string;
  requirements: string[];
  intensity: StyleIntensity;
};

export type OutfitScoreBreakdown = {
  color: number;
  silhouette: number;
  occasion: number;
  weather: number;
  style: number;
  preference: number;
  novelty: number;
};

export type OutfitCandidate = {
  id: string;
  title: string;
  score: number;
  scoreBreakdown: OutfitScoreBreakdown;
  itemIds: string[];
  items: WardrobeMatchItem[];
  highlights: string[];
  missingSuggestion?: string;
};

type StylingContext = {
  scene: string;
  prompt: string;
  weather?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  intensity?: StyleIntensity;
};

const neutralFamilies = new Set(["黑色", "白色", "灰色", "米色", "棕色"]);
const adjacentHues = new Set(["红色-黄色", "黄色-绿色", "绿色-蓝色", "蓝色-紫色", "紫色-红色"]);
const sceneFormality: Record<string, number> = { "运动": 1, "休闲": 2, "约会": 3, "聚会": 3, "通勤": 4, "正式活动": 5 };
const sceneStyles: Record<string, string[]> = {
  "通勤": ["通勤", "简约", "利落"], "约会": ["温柔", "精致", "约会"], "休闲": ["休闲", "松弛感", "简约"],
  "聚会": ["聚会", "时髦", "个性"], "运动": ["运动", "休闲", "活力"], "正式活动": ["正式", "精致", "简约"],
};

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function includesAny(value: string, keywords: string[]) {
  const normalized = value.toLowerCase();
  return keywords.some(keyword => normalized.includes(keyword.toLowerCase()));
}

function textList(value: unknown) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function numeric(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function targetWarmth(weather: Record<string, unknown> = {}) {
  const temperature = numeric(weather.apparent, numeric(weather.temperature, 22));
  let warmth = temperature >= 30 ? 1 : temperature >= 24 ? 2 : temperature >= 16 ? 3 : temperature >= 8 ? 4 : 5;
  const condition = `${weather.condition || ""}`;
  if (includesAny(condition, ["大风", "有风", "雨", "雪"])) warmth += 1;
  return clamp(Math.round(warmth), 1, 5);
}

function resolveIntensity(prompt: string, requested?: StyleIntensity): StyleIntensity {
  if (requested) return requested;
  if (includesAny(prompt, ["大胆", "出彩", "吸睛", "个性", "不一样"])) return "大胆一点";
  if (includesAny(prompt, ["低调", "稳妥", "不出错", "基础", "简单"])) return "稳妥耐看";
  return "有点风格";
}

export function deriveStylingIntent(context: StylingContext): StylingIntent {
  const prompt = context.prompt || "";
  const profileStyles = textList(context.profile?.stylePrefs);
  const styles = [...new Set([
    ...(sceneStyles[context.scene] || [context.scene]),
    ...profileStyles,
    ...["松弛", "精神", "温柔", "复古", "运动", "简约", "甜酷", "正式", "显比例"].filter(word => prompt.includes(word)),
  ])].slice(0, 6);
  const formalityDelta = includesAny(prompt, ["不太正式", "休闲", "松弛"]) ? -1 : includesAny(prompt, ["正式", "商务", "庄重"]) ? 1 : 0;
  const colorPreference = ["黑", "白", "灰", "米", "棕", "蓝", "绿", "红", "粉", "紫", "黄"].find(color => prompt.includes(color)) || "不限定";
  const requirements = ["显高", "显瘦", "显比例", "舒服", "保暖", "防雨", "不撞色", "有层次"].filter(word => prompt.includes(word));
  return {
    occasion: context.scene,
    styles,
    warmth: targetWarmth(context.weather),
    formality: clamp((sceneFormality[context.scene] || 3) + formalityDelta, 1, 5),
    colorPreference,
    requirements,
    intensity: resolveIntensity(prompt, context.intensity),
  };
}

function layerOf(item: WardrobeMatchItem) {
  if (["裤子", "裙子", "下装"].includes(item.category)) return "bottom";
  if (item.category === "连衣裙") return "dress";
  if (["鞋子", "鞋履"].includes(item.category)) return "shoes";
  if (item.category === "外套") return "outer";
  if (["帽子", "腰带", "包", "首饰", "配饰", "其他配饰"].includes(item.category)) return "accessory";
  return "top";
}

function familyOf(item: WardrobeMatchItem) {
  return item.aiTags.colorFamily || normalizeGarmentAITags(null, { category: item.category, color: item.colorName }).colorFamily;
}

function colorScore(items: WardrobeMatchItem[]) {
  const families = items.map(familyOf);
  const chromatic = [...new Set(families.filter(family => !neutralFamilies.has(family) && family !== "其他"))];
  const neutrals = families.filter(family => neutralFamilies.has(family)).length;
  const temperatures = new Set(items.map(item => item.aiTags.colorTemperature).filter(value => value && value !== "中性"));
  const lightness = new Set(items.map(item => item.aiTags.lightness));
  let score = 78;
  if (chromatic.length === 1 && neutrals >= 1) score += 14;
  else if (chromatic.length === 0 && lightness.size >= 2) score += 9;
  else if (chromatic.length === 2) {
    const pair = `${chromatic[0]}-${chromatic[1]}`;
    const reverse = `${chromatic[1]}-${chromatic[0]}`;
    score += adjacentHues.has(pair) || adjacentHues.has(reverse) ? 10 : 2;
  }
  if (chromatic.length > 2) score -= 18;
  if (temperatures.size > 1 && neutrals === 0) score -= 8;
  const loudPatterns = items.filter(item => item.aiTags.patternScale === "大" || item.aiTags.statementLevel >= 4).length;
  if (loudPatterns === 1) score += 5;
  if (loudPatterns > 1) score -= 12 * (loudPatterns - 1);
  return clamp(score);
}

function silhouetteScore(items: WardrobeMatchItem[], profile: Record<string, unknown> = {}, intent?: StylingIntent) {
  const top = items.find(item => ["top", "dress"].includes(layerOf(item)));
  const bottom = items.find(item => layerOf(item) === "bottom");
  const outer = items.find(item => layerOf(item) === "outer");
  const accessory = items.find(item => layerOf(item) === "accessory");
  if (!top || (!bottom && layerOf(top) !== "dress")) return 68;
  const topShape = `${top.aiTags.fit} ${top.aiTags.silhouette} ${top.aiTags.length}`;
  const bottomShape = bottom ? `${bottom.aiTags.fit} ${bottom.aiTags.silhouette} ${bottom.aiTags.legShape} ${bottom.aiTags.rise}` : "";
  const topLoose = includesAny(topShape, ["宽松", "oversize", "廓形"]);
  const bottomLoose = includesAny(bottomShape, ["宽松", "阔腿", "伞裙", "廓形"]);
  let score = 82;
  if (topLoose !== bottomLoose) score += 10;
  if (topLoose && bottomLoose) score += intent?.styles.some(style => includesAny(style, ["松弛", "休闲"])) ? 1 : -13;
  if (includesAny(topShape, ["短款", "修身"]) && includesAny(bottomShape, ["高腰", "阔腿", "直筒"])) score += 8;
  if (outer && outer.aiTags.length === "长款" && bottomLoose) score -= 5;
  const bodyType = String(profile.bodyType || "");
  if (bodyType === "梨形" && bottom && neutralFamilies.has(familyOf(bottom)) && top.aiTags.statementLevel >= 3) score += 5;
  if (bodyType === "直筒型" && (includesAny(topShape, ["短款", "收腰"]) || accessory?.aiTags.subcategory.includes("腰带"))) score += 5;
  if (bodyType === "倒三角" && bottomLoose) score += 5;
  if (bodyType === "沙漏型" && includesAny(topShape, ["修身", "收腰"])) score += 4;
  return clamp(score);
}

function itemContextScore(item: WardrobeMatchItem, intent: StylingIntent) {
  const occasion = item.aiTags.occasions.includes(intent.occasion) ? 100 : 78 - Math.abs(item.aiTags.formality - intent.formality) * 10;
  const weather = 100 - Math.abs(item.aiTags.warmth - intent.warmth) * 18;
  const styleMatches = item.aiTags.styles.filter(style => intent.styles.some(target => target.includes(style) || style.includes(target))).length;
  const style = clamp(68 + styleMatches * 12);
  const preferredColor = intent.colorPreference === "不限定" || item.colorName.includes(intent.colorPreference) || familyOf(item).includes(intent.colorPreference);
  return occasion * .35 + weather * .35 + style * .2 + (preferredColor ? 100 : 70) * .1;
}

function outfitTitle(items: WardrobeMatchItem[], intent: StylingIntent) {
  const hero = items.find(item => item.aiTags.statementLevel >= 4 || item.aiTags.role.includes("主角"));
  const accessory = items.find(item => layerOf(item) === "accessory");
  const families = new Set(items.map(familyOf));
  if (intent.intensity === "大胆一点" && hero) return "有记忆点的今日穿搭";
  if (families.size <= 2) return "同色系显比例";
  if (accessory) return "克制但有亮点";
  return intent.occasion === "通勤" ? "利落不刻板" : "松弛又有精神";
}

function scoreCandidate(items: WardrobeMatchItem[], intent: StylingIntent, profile: Record<string, unknown> = {}) {
  const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  const occasion = average(items.map(item => item.aiTags.occasions.includes(intent.occasion) ? 100 : 78 - Math.abs(item.aiTags.formality - intent.formality) * 10));
  const weather = average(items.map(item => 100 - Math.abs(item.aiTags.warmth - intent.warmth) * 18));
  const styleMatches = items.flatMap(item => item.aiTags.styles).filter(style => intent.styles.some(target => target.includes(style) || style.includes(target))).length;
  const style = clamp(72 + styleMatches * 7);
  const preferred = intent.colorPreference === "不限定" ? 82 : items.some(item => item.colorName.includes(intent.colorPreference) || familyOf(item).includes(intent.colorPreference)) ? 100 : 62;
  const statementLevels = items.map(item => item.aiTags.statementLevel);
  const statementCount = statementLevels.filter(level => level >= 4).length;
  const targetStatement = intent.intensity === "稳妥耐看" ? 1 : intent.intensity === "大胆一点" ? 4 : 2;
  const novelty = clamp(96 - Math.abs(average(statementLevels) - targetStatement) * 16 - Math.max(0, statementCount - 1) * 12);
  const breakdown: OutfitScoreBreakdown = {
    color: colorScore(items),
    silhouette: silhouetteScore(items, profile, intent),
    occasion: clamp(occasion),
    weather: clamp(weather),
    style,
    preference: preferred,
    novelty,
  };
  const score = Math.round(
    breakdown.color * .25 + breakdown.silhouette * .25 + breakdown.occasion * .15 + breakdown.weather * .15
    + breakdown.style * .1 + breakdown.preference * .05 + breakdown.novelty * .05,
  );
  return { score: clamp(score, 60, 98), breakdown };
}

function candidateHighlights(breakdown: OutfitScoreBreakdown, intent: StylingIntent) {
  const labels: Array<[keyof OutfitScoreBreakdown, string]> = [
    ["color", "色彩有呼应"], ["silhouette", "比例更利落"], ["occasion", `${intent.occasion}合适`],
    ["weather", "体感舒服"], ["style", "风格统一"], ["novelty", "有一点记忆点"],
  ];
  return labels.sort((a, b) => breakdown[b[0]] - breakdown[a[0]]).slice(0, 3).map(([, label]) => label);
}

function jaccard(left: string[], right: string[]) {
  const a = new Set(left);
  const b = new Set(right);
  const intersection = [...a].filter(value => b.has(value)).length;
  return intersection / Math.max(new Set([...a, ...b]).size, 1);
}

export function selectDiverseCandidates(candidates: OutfitCandidate[], count: number, maximumOverlap = .68) {
  const selected: OutfitCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.every(existing => jaccard(existing.itemIds, candidate.itemIds) <= maximumOverlap)) selected.push(candidate);
    if (selected.length === count) return selected;
  }
  for (const candidate of candidates) {
    if (!selected.some(existing => existing.itemIds.join("|") === candidate.itemIds.join("|"))) selected.push(candidate);
    if (selected.length === count) break;
  }
  return selected;
}

export function buildOutfitCandidates(rawItems: WardrobeMatchItem[], context: StylingContext, limit = 24) {
  const intent = deriveStylingIntent(context);
  const items = rawItems.map(item => ({
    ...item,
    aiTags: normalizeGarmentAITags(item.aiTags, { category: item.category, color: item.colorName, season: item.season, style: item.style }),
  }));
  const ranked = [...items].sort((a, b) => itemContextScore(b, intent) - itemContextScore(a, intent));
  const byLayer = (layer: string, count: number) => ranked.filter(item => layerOf(item) === layer).slice(0, count);
  const tops = byLayer("top", 7);
  const bottoms = byLayer("bottom", 7);
  const dresses = byLayer("dress", 6);
  const shoes = byLayer("shoes", 6);
  const outers = byLayer("outer", 4);
  const accessories = byLayer("accessory", 6);
  const shoeOptions: Array<WardrobeMatchItem | null> = shoes.length ? shoes : [null];
  const outerOptions: Array<WardrobeMatchItem | null> = intent.warmth >= 4 && outers.length ? outers.slice(0, 3) : [null, ...outers.slice(0, 2)];
  const accessoryOptions: Array<WardrobeMatchItem | null> = [null, ...accessories.slice(0, 4)];
  const unique = new Map<string, OutfitCandidate>();

  const add = (selection: Array<WardrobeMatchItem | null>) => {
    const selected = [...new Map(selection.filter((item): item is WardrobeMatchItem => Boolean(item)).map(item => [item.id, item])).values()];
    const layers = new Set(selected.map(layerOf));
    if (selected.length < 2 || (!layers.has("dress") && !(layers.has("top") || layers.has("outer"))) || (!layers.has("dress") && !layers.has("bottom"))) return;
    const signature = selected.map(item => item.id).sort().join("|");
    const { score, breakdown } = scoreCandidate(selected, intent, context.profile);
    const missing = !layers.has("shoes") ? "衣柜里暂时没有适合这套的鞋，可优先补一双中性色基础鞋" : undefined;
    const candidate: OutfitCandidate = {
      id: "",
      title: outfitTitle(selected, intent),
      score,
      scoreBreakdown: breakdown,
      itemIds: selected.map(item => item.id),
      items: selected,
      highlights: candidateHighlights(breakdown, intent),
      missingSuggestion: missing,
    };
    const previous = unique.get(signature);
    if (!previous || candidate.score > previous.score) unique.set(signature, candidate);
  };

  for (const top of tops) for (const bottom of bottoms) for (const shoe of shoeOptions) {
    for (const outer of outerOptions) for (const accessory of accessoryOptions) add([top, bottom, shoe, outer, accessory]);
  }
  for (const dress of dresses) for (const shoe of shoeOptions) {
    for (const outer of outerOptions) for (const accessory of accessoryOptions) add([dress, shoe, outer, accessory]);
  }
  if (!tops.length && outers.length) for (const outer of outers) for (const bottom of bottoms) for (const shoe of shoeOptions) add([outer, bottom, shoe]);

  if (!unique.size) {
    const groups = [tops, dresses, outers, bottoms, shoes, accessories].filter(group => group.length);
    for (let index = 0; index < 3; index += 1) add(groups.map(group => group[index % group.length]));
  }

  const sorted = [...unique.values()].sort((a, b) => b.score - a.score);
  const pool = selectDiverseCandidates(sorted, limit, .8);
  return {
    intent,
    candidates: pool.map((candidate, index) => ({ ...candidate, id: `candidate-${String(index + 1).padStart(2, "0")}` })),
  };
}

/**
 * 点评用户手动搭配的一套单品：返回意图、总分、分维度得分与亮点。
 * 供「自主搭配」的 AI 点评使用。
 */
export function reviewOutfit(
  items: WardrobeMatchItem[],
  context: { scene: string; prompt?: string; weather?: Record<string, unknown>; profile?: Record<string, unknown>; intensity?: StyleIntensity },
) {
  const intent = deriveStylingIntent({ ...context, prompt: context.prompt || "" });
  const { score, breakdown } = scoreCandidate(items, intent, context.profile);
  const highlights = candidateHighlights(breakdown, intent);
  return { intent, score, breakdown, highlights };
}

