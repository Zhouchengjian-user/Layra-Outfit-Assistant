"use client";

/* Dynamic R2 and user-uploaded image URLs cannot use a fixed Next Image loader. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { processGarmentUpload, type ProcessedGarmentImage } from "./lib/garment-image";
import { garmentTagLabels, type GarmentAITags } from "./lib/garment-tags";
import { ApiError, createIdempotencyKey, requestJson } from "./lib/api-client";
import {
  buildTryOnQuickPreview,
  pollRecommendationTask,
  pollVisualizationTask,
  submitRecommendationTask,
  submitVisualizationTask,
  type OutfitIntent,
  type OutfitRecommendation,
  type RecommendationPayload,
  type StyleIntensity,
  type TaskPhase,
} from "./lib/outfit-client";
import { AuthGate, useAuth } from "./components/auth-gate";
import { LayraMark } from "./components/layra-mark";
import { ModalFrame } from "./components/modal-frame";
import { STARTER_WARDROBE_SIZE_PER_GENDER } from "./lib/starter-wardrobe-config";

type Tab = "home" | "wardrobe" | "create" | "inspiration" | "saved" | "profile";
type Scene = "通勤" | "约会" | "休闲" | "聚会" | "运动" | "正式活动";
type Scope = "仅个人衣柜" | "衣柜＋建议添置" | "灵感扩展";
type ChatMessage = { role: "user" | "assistant"; text: string };
type WardrobeItem = {
  id: string; name: string; category: string; colorName: string; colorHex: string;
  season: string; style: string; status: "available" | "washing"; createdAt: number; imageUrl: string; aiTags: GarmentAITags & { starterGender?: "女" | "男"; starterId?: string }; tagVersion: number;
};
type GarmentDraft = ProcessedGarmentImage & { id: string; selected: boolean };
type ModelProfile = { quality: string; createdAt: number; updatedAt: number; imageUrl: string };
type WeatherContext = { city: string; temperature: number; apparent: number; condition: string; precipitation: number; wind: number; source: string };
type OutfitReview = {
  score: number;
  breakdown: { color: number; silhouette: number; occasion: number; weather: number; style: number; preference: number; novelty: number };
  highlights: string[];
  suggestion: string;
  items: Array<{ id: string; name: string; category: string; colorName: string; imageUrl: string }>;
};
type SavedOutfit = {
  id: string;
  title: string;
  scene: string;
  itemIds: string[];
  createdAt: number;
  items: Array<{ id: string; name: string; category: string; colorName: string; imageUrl: string }>;
};
type HistoryEntry = { id: string; scene: string; prompt: string; result: unknown; createdAt: number };
type TryOnContext = { itemIds: string[]; title: string; scene: string; recommendationId?: string };

function outfitItemFromWardrobe(item: WardrobeItem): OutfitRecommendation["items"][number] {
  return {
    id: item.id,
    name: item.name,
    category: item.category,
    colorName: item.colorName,
    season: item.season,
    style: item.style,
    imageUrl: item.imageUrl,
  };
}

function replaceOutfitCategory(
  currentItems: OutfitRecommendation["items"],
  category: string,
  newItem: WardrobeItem,
) {
  const items = [...currentItems];
  const mapped = outfitItemFromWardrobe(newItem);
  const index = items.findIndex(item => item.category === category);
  if (index >= 0) {
    items[index] = mapped;
  } else if (items.length < 6) {
    items.push(mapped);
  } else {
    const accessoryIndex = items.findIndex(item => ["配饰", "帽子"].includes(item.category));
    items[accessoryIndex >= 0 ? accessoryIndex : items.length - 1] = mapped;
  }
  return items;
}

function garmentDraftFromProcessed(item: ProcessedGarmentImage): GarmentDraft {
  return {
    ...item,
    id: item.draftKey,
    selected: item.cutoutQuality === "good" && item.completionStatus === "not-needed",
  };
}

/** Preserve card order while recognition previews are replaced out of order. */
function mergeGarmentDrafts(current: GarmentDraft[], incoming: GarmentDraft[]) {
  const next = [...current];
  const positions = new Map(next.map((item, index) => [item.draftKey, index]));
  for (const item of incoming) {
    const position = positions.get(item.draftKey);
    if (position === undefined) {
      positions.set(item.draftKey, next.length);
      next.push(item);
    } else {
      next[position] = { ...item, id: next[position].id };
    }
  }
  return next;
}

function formatHistoryDate(createdAt: number) {
  const diff = Date.now() - createdAt;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  const date = new Date(createdAt);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function parseSwapCategory(text: string): string | null {
  if (/鞋/.test(text)) return "鞋履";
  if (/外套|大衣|风衣/.test(text)) return "外套";
  if (/连衣裙|连体/.test(text)) return "连衣裙";
  if (/下装|裤子|裤|裙子|裙/.test(text)) return "下装";
  if (/帽/.test(text)) return "帽子";
  if (/配饰|包|腰带|首饰|项链|耳环|围巾/.test(text)) return "配饰";
  if (/上衣|内搭|衬衫|T恤|t恤|针织|卫衣|毛衣/.test(text)) return "上衣";
  return null;
}

const scenes: Scene[] = ["通勤", "约会", "休闲", "聚会", "运动", "正式活动"];
const prompts = ["帮我推荐今日穿搭", "今天想穿得松弛又精神", "晚上的约会怎么穿？", "帮我搭一套显比例的通勤装", "明天上班想穿得舒服又有精神", "约会想穿得温柔一点", "通勤但不要太正式", "下雨天也要显比例"];
const promptStarters = ["舒服又精神", "约会温柔一点", "通勤但不太正式"];
const styleOptions = ["简约", "松弛感", "轻复古", "通勤", "运动", "甜酷"];
const lastRecommendationTaskKey = "yida:last-recommendation-task";
const lastVisualizationTaskKey = "yida:last-visualization-task";
const lastVisualizationLookKey = "yida:last-visualization-look";

const garments = [
  { id: 1, name: "奶油白针织衫", type: "上衣", color: "cream", meta: "奶油白 · 针织", season: "春秋" },
  { id: 2, name: "橄榄绿西装", type: "上衣", color: "olive", meta: "橄榄绿 · 西装", season: "四季" },
  { id: 3, name: "浅蓝牛仔裤", type: "下装", color: "denim", meta: "浅蓝 · 牛仔", season: "四季" },
  { id: 4, name: "炭灰阔腿裤", type: "下装", color: "charcoal", meta: "炭灰 · 西裤", season: "四季" },
  { id: 5, name: "焦糖乐福鞋", type: "鞋履", color: "caramel", meta: "焦糖 · 皮革", season: "春秋" },
  { id: 6, name: "白色运动鞋", type: "鞋履", color: "white", meta: "白色 · 运动", season: "四季" },
  { id: 7, name: "酒红腋下包", type: "配饰", color: "wine", meta: "酒红 · 皮革", season: "四季" },
  { id: 8, name: "黑色棒球帽", type: "帽子", color: "black", meta: "黑色 · 棉质", season: "四季" },
];

type InspirationGender = "female" | "male";
type InspirationTheme = { id: string; title: string; desc: string; colors: string[]; imageUrl: string };

const INSPIRATION_BATCH_SIZE = 6;
const inspirationThemes: Record<InspirationGender, InspirationTheme[]> = {
  female: [
    { id: "female-look-01", title: "清爽学院感", desc: "蓝白层次清爽，适合上课与周末看展", colors: ["cream", "denim", "white"], imageUrl: "/inspiration/female/look-01.webp" },
    { id: "female-look-02", title: "不费力通勤", desc: "柔和西装配利落下装，上班不显拘谨", colors: ["olive", "charcoal", "caramel"], imageUrl: "/inspiration/female/look-02.webp" },
    { id: "female-look-03", title: "温柔约会感", desc: "低饱和配色轻盈耐看，适合晚餐和看展", colors: ["cream", "wine", "white"], imageUrl: "/inspiration/female/look-03.webp" },
    { id: "female-look-04", title: "轻复古周末", desc: "牛仔与焦糖色增加质感，周末轻松好穿", colors: ["denim", "caramel", "black"], imageUrl: "/inspiration/female/look-04.webp" },
    { id: "female-look-05", title: "运动松弛感", desc: "舒适单品保持清晰比例，运动后也有型", colors: ["white", "charcoal", "black"], imageUrl: "/inspiration/female/look-05.webp" },
    { id: "female-look-06", title: "正式但不老气", desc: "用干净线条和克制配色撑住正式场合", colors: ["olive", "cream", "charcoal"], imageUrl: "/inspiration/female/look-06.webp" },
    { id: "female-look-07", title: "城市机能感", desc: "深浅层次利落，适合步行和城市移动", colors: ["charcoal", "black", "wine"], imageUrl: "/inspiration/female/look-07.webp" },
    { id: "female-look-08", title: "雨天层次感", desc: "外层防风，内搭保持轻盈，阴雨天不沉闷", colors: ["olive", "charcoal", "black"], imageUrl: "/inspiration/female/look-08.webp" },
    { id: "female-look-09", title: "极简黑白", desc: "黑白灰关系清楚，简单却有完整度", colors: ["black", "white", "charcoal"], imageUrl: "/inspiration/female/look-09.webp" },
    { id: "female-look-10", title: "低饱和文艺", desc: "柔和中性色搭配一点蓝，安静但不单调", colors: ["cream", "olive", "denim"], imageUrl: "/inspiration/female/look-10.webp" },
    { id: "female-look-11", title: "周末短途", desc: "轻便层次适合乘车、散步和临时拍照", colors: ["denim", "white", "caramel"], imageUrl: "/inspiration/female/look-11.webp" },
    { id: "female-look-12", title: "晚间聚会", desc: "深色基底配酒红重点，夜晚更有精神", colors: ["wine", "black", "cream"], imageUrl: "/inspiration/female/look-12.webp" },
  ],
  male: [
    { id: "male-look-01", title: "清爽学院感", desc: "蓝白与深灰干净清楚，适合上课和看展", colors: ["white", "denim", "charcoal"], imageUrl: "/inspiration/male/look-01.webp" },
    { id: "male-look-02", title: "不费力通勤", desc: "软结构外套配直线下装，通勤利落不紧绷", colors: ["olive", "charcoal", "caramel"], imageUrl: "/inspiration/male/look-02.webp" },
    { id: "male-look-03", title: "轻松约会感", desc: "中性色保持松弛，晚餐和散步都合适", colors: ["cream", "charcoal", "white"], imageUrl: "/inspiration/male/look-03.webp" },
    { id: "male-look-04", title: "轻复古周末", desc: "牛仔与暖棕增加质感，周末不用费力", colors: ["denim", "caramel", "olive"], imageUrl: "/inspiration/male/look-04.webp" },
    { id: "male-look-05", title: "运动松弛感", desc: "轻量运动单品有层次，舒适也保持比例", colors: ["black", "charcoal", "white"], imageUrl: "/inspiration/male/look-05.webp" },
    { id: "male-look-06", title: "正式但不老气", desc: "深色线条加浅色内搭，正式但不显老成", colors: ["charcoal", "white", "caramel"], imageUrl: "/inspiration/male/look-06.webp" },
    { id: "male-look-07", title: "城市机能感", desc: "深色功能层叠穿，适合通勤和城市步行", colors: ["denim", "cream", "black"], imageUrl: "/inspiration/male/look-07.webp" },
    { id: "male-look-08", title: "雨天层次感", desc: "防风外层配深色下装，雨天也保持清爽", colors: ["olive", "charcoal", "black"], imageUrl: "/inspiration/male/look-08.webp" },
    { id: "male-look-09", title: "极简黑白", desc: "黑白灰比例清楚，适合高频重复穿着", colors: ["black", "white", "charcoal"], imageUrl: "/inspiration/male/look-09.webp" },
    { id: "male-look-10", title: "低饱和文艺", desc: "灰绿与米白更柔和，适合展览和咖啡馆", colors: ["cream", "olive", "charcoal"], imageUrl: "/inspiration/male/look-10.webp" },
    { id: "male-look-11", title: "周末短途", desc: "牛仔配暖调单品，轻便应对短途出行", colors: ["caramel", "denim", "cream"], imageUrl: "/inspiration/male/look-11.webp" },
    { id: "male-look-12", title: "晚间聚会", desc: "黑色基底配酒红重点，适合晚餐和聚会", colors: ["black", "white", "wine"], imageUrl: "/inspiration/male/look-12.webp" },
  ],
};

function Icon({ name }: { name: string }) {
  const frame = (children: React.ReactNode) => <svg className="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">{children}</svg>;
  switch (name) {
    case "home": return frame(<><path d="M3.5 10.8 12 3.8l8.5 7" /><path d="M5.7 9.5v10.2h12.6V9.5M9.4 19.7v-6.1h5.2v6.1" /></>);
    case "wardrobe": return frame(<><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M12 3.5v17M9 11.7h.1M14.9 11.7h.1" /></>);
    case "create": return frame(<><path d="M12 4v16M4 12h16" /></>);
    case "profile": return frame(<><circle cx="12" cy="8" r="3.3" /><path d="M5.2 20c.5-4 2.8-6.1 6.8-6.1s6.3 2.1 6.8 6.1" /></>);
    case "gallery": return frame(<><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="8.5" cy="9" r="1.5" /><path d="m5.5 17 4.2-4.3 3 2.7 2.5-2.5 3.3 4.1" /></>);
    case "saved":
    case "heart": return frame(<path d="M20.2 5.8c-2-2.1-5.2-1.8-7.1.3L12 7.3l-1.1-1.2C9 4 5.8 3.7 3.8 5.8c-2.1 2.2-1.8 5.5.4 7.6L12 21l7.8-7.6c2.2-2.1 2.5-5.4.4-7.6Z" />);
    case "help": return frame(<><circle cx="12" cy="12" r="9" /><path d="M9.7 9a2.5 2.5 0 1 1 3.2 2.4c-.9.4-1.2.9-1.2 1.8M11.8 17h.1" /></>);
    case "history": return frame(<><path d="M4.4 9A8 8 0 1 1 4 14" /><path d="M4.4 4.5V9h4.5M12 7.4V12l3 1.8" /></>);
    case "sun": return frame(<><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" /></>);
    case "spark": return frame(<><path d="m12 2 1.6 5.1L19 9l-5.4 1.9L12 16l-1.6-5.1L5 9l5.4-1.9L12 2Z" /><path d="m18.5 15 .8 2.3 2.2.7-2.2.8-.8 2.2-.7-2.2-2.3-.8 2.3-.7Z" /></>);
    case "camera": return frame(<><path d="M4 8.2h3l1.4-2.3h7.2L17 8.2h3v10.3H4V8.2Z" /><circle cx="12" cy="13.2" r="3.1" /></>);
    case "check": return frame(<path d="m5 12.5 4.3 4.2L19 7" />);
    case "arrow": return frame(<><path d="M5 12h14M14 7l5 5-5 5" /></>);
    case "tune": return frame(<><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>);
    case "calendar": return frame(<><rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M8 3v4M16 3v4M4 10h16" /></>);
    default: return frame(<circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />);
  }
}

function GarmentArt({ color, mini = false }: { color: string; mini?: boolean }) {
  return <div className={`garment-art ${color} ${mini ? "mini" : ""}`}><span className="garment-neck" /><span className="garment-body" /><span className="garment-detail" /></div>;
}

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const items: Array<{ id: Tab; name: string; icon: string }> = [
    { id: "home", name: "今日", icon: "home" }, { id: "wardrobe", name: "衣柜", icon: "wardrobe" },
    { id: "create", name: "搭配", icon: "create" }, { id: "inspiration", name: "灵感", icon: "gallery" },
    { id: "profile", name: "我的", icon: "profile" },
  ];
  return <nav className="bottom-nav" aria-label="主导航">{items.map(item => <button key={item.id} className={tab === item.id || (item.id === "profile" && tab === "saved") ? "active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} /><small>{item.name}</small></button>)}</nav>;
}

function ModelProfileStrip({ profile, uploading, onUpload }: { profile: ModelProfile | null; uploading: boolean; onUpload: () => void }) {
  return <section className={`model-profile-strip ${profile ? "is-ready" : ""}`}>
    <button className="model-profile-preview" onClick={onUpload} aria-label={profile ? "更换个人全身照" : "上传个人全身照"}>
      {profile ? <img src={profile.imageUrl} alt="我的个人模特全身照" /> : <span>＋</span>}
    </button>
    <div><span className="micro-label">MY AI MODEL</span><b>{profile ? "个人模特已准备好" : "先建立你的个人模特"}</b><small>{profile ? "推荐完成后，可直接生成你穿上这套的完整效果图" : "上传一张正面、从头到脚完整入镜的全身照"}</small></div>
    <button className="model-upload-action" disabled={uploading} onClick={onUpload}>{uploading ? "正在保存…" : profile ? "更换照片" : "上传全身照"}</button>
  </section>;
}

function YidaApp() {
  const { logout } = useAuth();
  const [tab, setTab] = useState<Tab>("home");
  const [promptIndex, setPromptIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [scene, setScene] = useState<Scene>("通勤");
  const scope: Scope = "仅个人衣柜";
  const [showResults, setShowResults] = useState(false);
  const [recommendationPhase, setRecommendationPhase] = useState<TaskPhase>("idle");
  const [generationsLeft, setGenerationsLeft] = useState(5);
  const [recommendations, setRecommendations] = useState<OutfitRecommendation[]>([]);
  const [outfitIntent, setOutfitIntent] = useState<OutfitIntent | null>(null);
  const [selectedRecommendationId, setSelectedRecommendationId] = useState<string | null>(null);
  const [modelProfile, setModelProfile] = useState<ModelProfile | null>(null);
  const [ownerReady, setOwnerReady] = useState(false);
  const [modelUploading, setModelUploading] = useState(false);
  const [tryOnPhase, setTryOnPhase] = useState<TaskPhase>("idle");
  const [tryOnUrl, setTryOnUrl] = useState("");
  const [tryOnQuickUrl, setTryOnQuickUrl] = useState("");
  const [showTryOn, setShowTryOn] = useState(false);
  const [weather, setWeather] = useState<WeatherContext>({ city: "杭州", temperature: 24, apparent: 25, condition: "多云", precipitation: 0, wind: 8, source: "fallback" });
  const [wardrobeItems, setWardrobeItems] = useState<WardrobeItem[]>([]);
  const [wardrobeLoading, setWardrobeLoading] = useState(true);
  const [starterLoading, setStarterLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [uploadBackgroundPending, setUploadBackgroundPending] = useState(false);
  const [uploadSaving, setUploadSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadPhotoPreviews, setUploadPhotoPreviews] = useState<string[]>([]);
  const [garmentDrafts, setGarmentDrafts] = useState<GarmentDraft[]>([]);
  const [editingWardrobe, setEditingWardrobe] = useState<WardrobeItem | null>(null);
  const [closetFilter, setClosetFilter] = useState("全部");
  const [activeCloset, setActiveCloset] = useState<"own" | "female" | "male">("own");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [reviewResult, setReviewResult] = useState<OutfitReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [savedOutfits, setSavedOutfits] = useState<SavedOutfit[]>([]);
  const [saveLoading, setSaveLoading] = useState(false);
  const [tryOnContext, setTryOnContext] = useState<TryOnContext | null>(null);
  const [showSwapModal, setShowSwapModal] = useState(false);
  const [swapCategory, setSwapCategory] = useState("");
  const [tryOnChatInput, setTryOnChatInput] = useState("");
  const [toast, setToast] = useState("");
  const [stylePrefs, setStylePrefs] = useState<string[]>(["松弛感", "简约"]);
  const [styleIntensity] = useState<StyleIntensity>("有点风格");
  const [city, setCity] = useState("杭州");
  const [showWeather, setShowWeather] = useState(false);
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [showStarterPicker, setShowStarterPicker] = useState(false);
  const [inspirationBrowseState, setInspirationBrowseState] = useState<{
    gender: InspirationGender;
    batch: number;
    status: string;
  }>({ gender: "female", batch: 0, status: "" });

  useEffect(() => {
    const surface = document.querySelector<HTMLElement>(".studio-surface");
    if (window.matchMedia("(max-width: 820px)").matches) window.scrollTo({ top: 0 });
    else surface?.scrollTo({ top: 0 });
  }, [tab]);
  const [profile, setProfile] = useState({ nickname: "阿禾", gender: "女", height: "168", weight: "55", bodyType: "直筒型" });

  const [chatInput, setChatInput] = useState("");
  const [chatTyping, setChatTyping] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([{ role: "assistant", text: "三套都来自你的衣柜。想换颜色、鞋子或调整正式程度，直接告诉我。" }]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const homeStageRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const modelFileRef = useRef<HTMLInputElement>(null);
  const uploadModeRef = useRef<"replace" | "append">("replace");
  const uploadBatchRef = useRef(0);
  const uploadJobActiveRef = useRef(false);
  const outfitJobActiveRef = useRef(false);
  const tryOnJobActiveRef = useRef(false);
  const tryOnPreviewJobRef = useRef("");
  const tryOnQuickUrlRef = useRef("");
  const tryOnCacheRef = useRef<Map<string, string>>(new Map());
  const loading = ["submitting", "running", "recovering"].includes(recommendationPhase);
  const tryOnLoading = ["submitting", "running", "recovering"].includes(tryOnPhase);
  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

  const replaceTryOnQuickUrl = useCallback((url = "") => {
    if (tryOnQuickUrlRef.current && tryOnQuickUrlRef.current !== url) URL.revokeObjectURL(tryOnQuickUrlRef.current);
    tryOnQuickUrlRef.current = url;
    setTryOnQuickUrl(url);
  }, []);

  const tryOnCacheKey = useCallback((itemIds: string[]) => [
    "source-frame-v4",
    modelProfile?.updatedAt || 0,
    [...itemIds].sort().join("|"),
    scene,
    prompt.trim(),
  ].join("::"), [modelProfile?.updatedAt, prompt, scene]);

  const startTryOnQuickPreview = useCallback((jobId: string, items: OutfitRecommendation["items"], title: string) => {
    if (!modelProfile?.imageUrl || !items.length) return;
    tryOnPreviewJobRef.current = jobId;
    void buildTryOnQuickPreview(modelProfile.imageUrl, items, title)
      .then(blob => {
        if (tryOnPreviewJobRef.current !== jobId) return;
        replaceTryOnQuickUrl(URL.createObjectURL(blob));
      })
      .catch(() => undefined);
  }, [modelProfile, replaceTryOnQuickUrl]);

  const ownGarmentCount = wardrobeItems.filter(item => !item.aiTags?.starterGender).length;
  // 当前衣柜视图下的单品（own=自己的，female/male=对应性别预设）
  const activeItems = wardrobeItems.filter(item =>
    activeCloset === "own" ? !item.aiTags?.starterGender
      : item.aiTags?.starterGender === (activeCloset === "female" ? "女" : "男"),
  );

  const reviewOutfit = async () => {
    if (selectedItems.length < 2 || reviewLoading) return;
    setReviewLoading(true);
    setReviewResult(null);
    try {
      const { data } = await requestJson<OutfitReview>("/api/outfits/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: selectedItems, scene, weather, profile: { ...profile, stylePrefs } }),
        timeoutMs: 45_000,
      });
      setReviewResult(data);
    } catch (error) {
      notify(error instanceof Error ? error.message : "点评失败，请稍后重试");
    } finally {
      setReviewLoading(false);
    }
  };

  const generateTryOnForCreate = async () => {
    if (selectedItems.length < 2) { notify("请先选择至少 2 件单品"); return; }
    if (!modelProfile) { modelFileRef.current?.click(); return; }
    if (tryOnJobActiveRef.current) { setShowTryOn(true); notify("高清效果图仍在生成，可以先看搭配速览"); return; }
    const cacheKey = tryOnCacheKey(selectedItems);
    const cachedUrl = tryOnCacheRef.current.get(cacheKey);
    setTryOnContext({ itemIds: selectedItems, title: "我的自主搭配", scene });
    if (cachedUrl) {
      replaceTryOnQuickUrl();
      setTryOnUrl(cachedUrl);
      setShowTryOn(true);
      setTryOnPhase("succeeded");
      return;
    }
    tryOnJobActiveRef.current = true;
    setTryOnUrl("");
    replaceTryOnQuickUrl();
    setShowTryOn(true);
    setTryOnPhase("submitting");
    let taskId = "";
    try {
      taskId = createIdempotencyKey();
      const previewItems = selectedItems
        .map(id => wardrobeItems.find(item => item.id === id))
        .filter((item): item is WardrobeItem => Boolean(item));
      startTryOnQuickPreview(taskId, previewItems, "我的自主搭配");
      const form = new FormData();
      form.append("itemIds", JSON.stringify(selectedItems));
      form.append("title", "我的自主搭配");
      form.append("scene", scene);
      form.append("prompt", prompt);
      setTryOnPhase("running");
      const resultUrl = URL.createObjectURL(await submitVisualizationTask(taskId, form));
      tryOnPreviewJobRef.current = "";
      tryOnCacheRef.current.set(cacheKey, resultUrl);
      setTryOnUrl(resultUrl);
      setTryOnPhase("succeeded");
    } catch (error) {
      setTryOnPhase("failed");
      setShowTryOn(false);
      notify(error instanceof Error ? error.message : "效果图生成失败");
    } finally {
      tryOnJobActiveRef.current = false;
    }
  };

  const loadSavedOutfits = useCallback(async () => {
    try {
      const { data } = await requestJson<{ saved: SavedOutfit[] }>("/api/outfits/saved", { timeoutMs: 15_000 });
      setSavedOutfits(data.saved || []);
    } catch {
      // 加载失败忽略
    }
  }, []);

  const saveCurrentOutfit = async () => {
    if (!tryOnContext || saveLoading) return;
    setSaveLoading(true);
    try {
      await requestJson("/api/outfits/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: tryOnContext.itemIds, title: tryOnContext.title, scene: tryOnContext.scene }),
        timeoutMs: 20_000,
      });
      await loadSavedOutfits();
      notify("已保存到「我的搭配」");
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaveLoading(false);
    }
  };

  const deleteSavedOutfit = async (id: string) => {
    try {
      await requestJson(`/api/outfits/saved?id=${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 20_000 });
      setSavedOutfits(current => current.filter(item => item.id !== id));
      notify("已删除收藏");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败");
    }
  };

  const likeTheme = (themeTitle: string) => {
    setStylePrefs(current => {
      const next = current.includes(themeTitle) ? current : [...current, themeTitle].slice(0, 6);
      saveProfile(profile, next);
      return next;
    });
    notify(`已把「${themeTitle}」加入你的风格偏好`);
  };

  const saveThemeAsOutfit = async (theme: { title: string; colors: string[] }) => {
    const themeFamilyMap: Record<string, string[]> = {
      cream: ["米色", "白色", "奶油"], olive: ["绿色", "橄榄"], denim: ["蓝色", "牛仔"],
      charcoal: ["黑色", "灰色", "炭"], caramel: ["棕色", "焦糖"], white: ["白色"],
      wine: ["红色", "酒红"], black: ["黑色"],
    };
    const families = theme.colors.flatMap(color => themeFamilyMap[color] || []);
    const matches = activeItems.filter(item => item.status === "available" && families.some(family => item.colorName.includes(family) || item.aiTags.colorFamily === family));
    const byCategory = new Map<string, WardrobeItem>();
    for (const item of matches) {
      if (!byCategory.has(item.category)) byCategory.set(item.category, item);
    }
    const picked = [...byCategory.values()].slice(0, 6);
    if (picked.length < 2) {
      notify("衣柜里还没有足够匹配这个灵感的单品，先去上传一些衣服吧");
      setTab("wardrobe");
      return;
    }
    try {
      await requestJson("/api/outfits/saved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds: picked.map(item => item.id), title: `灵感 · ${theme.title}`, scene: "休闲" }),
        timeoutMs: 20_000,
      });
      await requestJson<{ saved: SavedOutfit[] }>("/api/outfits/saved", { timeoutMs: 15_000 }).then(({ data }) => setSavedOutfits(data.saved || []));
      notify("灵感已收藏到「我的搭配」，可以用衣柜复刻");
    } catch (error) {
      notify(error instanceof Error ? error.message : "收藏失败");
    }
  };

  useEffect(() => {
    if (!ownerReady) return;
    let active = true;
    requestJson<{ saved: SavedOutfit[] }>("/api/outfits/saved", { timeoutMs: 15_000 })
      .then(({ data }) => { if (active) setSavedOutfits(data.saved || []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [ownerReady]);

  useEffect(() => {
    if (!ownerReady) return;
    let active = true;
    requestJson<{ history: HistoryEntry[] }>("/api/outfits/history", { timeoutMs: 15_000 })
      .then(({ data }) => { if (active) setHistory(data.history || []); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [ownerReady]);

  const saveProfile = async (nextProfile: typeof profile, nextStylePrefs: string[]) => {
    try {
      await requestJson("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...nextProfile, stylePrefs: nextStylePrefs }),
        timeoutMs: 20_000,
      });
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败");
    }
  };

  const toggleStyle = (item: string) => {
    setStylePrefs(current => {
      const next = current.includes(item) ? current.filter(value => value !== item) : [...current, item];
      saveProfile(profile, next);
      return next;
    });
  };

  useEffect(() => {
    if (!ownerReady) return;
    requestJson<{ profile: { nickname: string; gender: string; height: string; weight: string; bodyType: string; stylePrefs: string[] } }>("/api/profile", { timeoutMs: 15_000 })
      .then(({ data }) => {
        if (!data.profile) return;
        setProfile({ nickname: data.profile.nickname, gender: data.profile.gender, height: data.profile.height, weight: data.profile.weight, bodyType: data.profile.bodyType });
        if (data.profile.stylePrefs?.length) setStylePrefs(data.profile.stylePrefs);
      })
      .catch(() => undefined);
  }, [ownerReady]);

  const replayHistory = (entry: HistoryEntry) => {
    const recs = (entry.result as { recommendations?: OutfitRecommendation[] } | null)?.recommendations;
    if (recs && recs.length) {
      setRecommendations(recs);
      // 回放旧推荐：清掉当前试穿缓存，避免与旧图串
      tryOnCacheRef.current.forEach(url => URL.revokeObjectURL(url));
      tryOnCacheRef.current.clear();
      setTryOnUrl("");
      setShowTryOn(false);
      window.sessionStorage.removeItem(lastVisualizationTaskKey);
      window.sessionStorage.removeItem(lastVisualizationLookKey);
      setScene(entry.scene as Scene);
      setShowResults(true);
      setSelectedRecommendationId(null);
      setTab("home");
    } else {
      setScene(entry.scene as Scene);
      setPrompt(entry.prompt);
      setTab("home");
    }
  };

  useEffect(() => {
    const timer = setInterval(() => setPromptIndex(current => { let next = Math.floor(Math.random() * prompts.length); if (next === current) next = (next + 1) % prompts.length; return next; }), 3000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => () => {
    tryOnPreviewJobRef.current = "";
    if (tryOnQuickUrlRef.current) URL.revokeObjectURL(tryOnQuickUrlRef.current);
    tryOnCacheRef.current.forEach(url => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (tab !== "home") return;
    const stage = homeStageRef.current;
    if (!stage) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (reduceMotion || !finePointer) return;
    let frame = 0;
    const updateLight = (event: PointerEvent) => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const bounds = stage.getBoundingClientRect();
        const x = Math.max(0, Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100));
        const y = Math.max(0, Math.min(100, ((event.clientY - bounds.top) / bounds.height) * 100));
        stage.style.setProperty("--home-pointer-x", `${x}%`);
        stage.style.setProperty("--home-pointer-y", `${y}%`);
      });
    };
    stage.addEventListener("pointermove", updateLight, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      stage.removeEventListener("pointermove", updateLight);
    };
  }, [tab]);

  useEffect(() => () => {
    tryOnCacheRef.current.forEach(url => URL.revokeObjectURL(url));
    tryOnCacheRef.current.clear();
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("yida:city");
      if (saved) {
        const timer = window.setTimeout(() => setCity(saved), 0);
        return () => window.clearTimeout(timer);
      }
    } catch { /* 忽略 */ }
    return undefined;
  }, []);

  useEffect(() => {
    try { localStorage.setItem("yida:city", city); } catch { /* 忽略 */ }
  }, [city]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("yida:generations");
      if (!saved) return;
      const parsed = JSON.parse(saved) as { date: string; left: number };
      const today = new Date().toISOString().slice(0, 10);
      if (parsed.date === today) {
        const timer = window.setTimeout(() => setGenerationsLeft(Math.max(0, Math.min(5, Number(parsed.left) || 5))), 0);
        return () => window.clearTimeout(timer);
      }
    } catch { /* 忽略 */ }
    return undefined;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (localStorage.getItem("yida:city")) return; // 已有常驻城市，不自动定位
    } catch { return; }
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async position => {
      try {
        const { data: payload } = await requestJson<WeatherContext>(
          `/api/weather?lat=${position.coords.latitude}&lon=${position.coords.longitude}`,
          { timeoutMs: 15_000 },
        );
        setWeather(payload);
        if (payload.city) {
          setCity(payload.city);
          try { localStorage.setItem("yida:city", payload.city); } catch { /* 忽略 */ }
        }
      } catch { /* 定位天气失败，保持默认 */ }
    }, () => { /* 拒绝定位，保持默认城市 */ }, { enableHighAccuracy: false, timeout: 8000 });
  }, []);

  useEffect(() => {
    let active = true;
    const profileRequest = ownerReady
      ? requestJson<{ profile?: ModelProfile | null }>("/api/model-profile", { timeoutMs: 15_000 }).then(result => result.data)
      : Promise.resolve({ profile: null });
    Promise.all([
      profileRequest,
      requestJson<WeatherContext>(`/api/weather?city=${encodeURIComponent(city)}`, { timeoutMs: 15_000 }).then(result => result.data),
    ]).then(([modelPayload, weatherPayload]) => {
      if (!active) return;
      setModelProfile(modelPayload.profile || null);
      if (weatherPayload.temperature !== undefined) setWeather(weatherPayload);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [city, ownerReady]);

  useEffect(() => {
    let active = true;
    requestJson<{ items?: WardrobeItem[] }>("/api/wardrobe", { timeoutMs: 20_000 })
      .then(({ data: payload }) => {
        if (active) setWardrobeItems(payload.items || []);
      })
      .catch(() => { if (active) notify("衣柜暂时没有同步成功，请稍后重试"); })
      .finally(() => {
        if (active) {
          setWardrobeLoading(false);
          setOwnerReady(true);
        }
      });
    return () => { active = false; };
  }, [notify]);

  const revealRecommendations = useCallback((payload: RecommendationPayload) => {
    if (!payload.recommendations?.length) throw new Error("本次没有生成可用搭配，请稍后重试");
    // 新一批推荐就绪：清掉上一轮的试穿图缓存与状态，避免串图
    tryOnCacheRef.current.forEach(url => URL.revokeObjectURL(url));
    tryOnCacheRef.current.clear();
    tryOnPreviewJobRef.current = "";
    replaceTryOnQuickUrl();
    setTryOnUrl("");
    setShowTryOn(false);
    window.sessionStorage.removeItem(lastVisualizationTaskKey);
    window.sessionStorage.removeItem(lastVisualizationLookKey);
    setRecommendations(payload.recommendations);
    setOutfitIntent(payload.intent || null);
    setSelectedRecommendationId(null);
    setShowResults(true);
    window.setTimeout(() => document.querySelector(".results-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }, [replaceTryOnQuickUrl]);

  useEffect(() => {
    if (!ownerReady || outfitJobActiveRef.current) return;
    const taskId = window.sessionStorage.getItem(lastRecommendationTaskKey);
    if (!taskId) return;
    const controller = new AbortController();
    outfitJobActiveRef.current = true;
    const phaseTimer = window.setTimeout(() => {
      if (!controller.signal.aborted) setRecommendationPhase("recovering");
    }, 0);
    pollRecommendationTask(taskId, controller.signal)
      .then(payload => {
        revealRecommendations(payload);
        setRecommendationPhase("succeeded");
        notify("已恢复上次的三套搭配");
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        window.sessionStorage.removeItem(lastRecommendationTaskKey);
        setRecommendationPhase("failed");
        if (!(error instanceof ApiError && error.status === 404)) notify(error instanceof Error ? error.message : "上次搭配暂时无法恢复");
      })
      .finally(() => { outfitJobActiveRef.current = false; });
    return () => {
      window.clearTimeout(phaseTimer);
      controller.abort();
    };
  }, [notify, ownerReady, revealRecommendations]);

  useEffect(() => {
    if (!ownerReady || !recommendations.length || tryOnJobActiveRef.current) return;
    const taskId = window.sessionStorage.getItem(lastVisualizationTaskKey);
    const lookId = window.sessionStorage.getItem(lastVisualizationLookKey);
    const look = recommendations.find(item => item.id === lookId);
    if (!taskId || !lookId || !look) return;
    const cacheKey = tryOnCacheKey(look.itemIds);
    const cachedUrl = tryOnCacheRef.current.get(cacheKey);
    if (cachedUrl) return;
    const controller = new AbortController();
    tryOnJobActiveRef.current = true;
    const phaseTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setSelectedRecommendationId(lookId);
      setTryOnContext({ itemIds: look.itemIds, title: look.title, scene, recommendationId: look.id });
      replaceTryOnQuickUrl();
      startTryOnQuickPreview(taskId, look.items, look.title);
      setShowTryOn(true);
      setTryOnPhase("recovering");
    }, 0);
    pollVisualizationTask(taskId, controller.signal)
      .then(blob => {
        const resultUrl = URL.createObjectURL(blob);
        tryOnPreviewJobRef.current = "";
        tryOnCacheRef.current.set(cacheKey, resultUrl);
        setTryOnUrl(resultUrl);
        setTryOnPhase("succeeded");
        notify("已恢复上次生成的个人效果图");
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        window.sessionStorage.removeItem(lastVisualizationTaskKey);
        window.sessionStorage.removeItem(lastVisualizationLookKey);
        setTryOnPhase("failed");
        setShowTryOn(false);
        if (!(error instanceof ApiError && error.status === 404)) notify(error instanceof Error ? error.message : "上次效果图暂时无法恢复");
      })
      .finally(() => { tryOnJobActiveRef.current = false; });
    return () => {
      window.clearTimeout(phaseTimer);
      controller.abort();
    };
  }, [notify, ownerReady, recommendations, replaceTryOnQuickUrl, scene, startTryOnQuickPreview, tryOnCacheKey]);

  const openUploadPicker = (mode: "replace" | "append" = "replace") => {
    if (uploadJobActiveRef.current) {
      notify("当前照片还在处理中，请完成后再继续添加");
      return;
    }
    uploadModeRef.current = mode;
    fileRef.current?.click();
  };

  const resetClosetScopedState = () => {
    setClosetFilter("全部");
    setSelectedItems([]);
    setReviewResult(null);
    setRecommendations([]);
    setOutfitIntent(null);
    setSelectedRecommendationId(null);
    setShowResults(false);
    setShowSwapModal(false);
    setShowTryOn(false);
    setTryOnContext(null);
  };

  const generateLooks = async () => {
    if (outfitJobActiveRef.current) { notify("正在生成这一组搭配，请稍等"); return; }
    if (generationsLeft <= 0) { notify("今天的生成次数已用完，明天 00:00 恢复"); return; }
    if (activeItems.filter(item => item.status === "available").length < 2) { notify("当前衣柜里至少需要 2 件可穿单品，先添加衣服吧"); setTab("wardrobe"); return; }
    outfitJobActiveRef.current = true;
    const taskId = createIdempotencyKey();
    window.sessionStorage.setItem(lastRecommendationTaskKey, taskId);
    setRecommendationPhase("submitting");
    try {
      const payload = await submitRecommendationTask(taskId, {
        prompt,
        scene,
        weather,
        profile: { ...profile, stylePrefs },
        intensity: styleIntensity,
        closet: activeCloset,
      });
      revealRecommendations(payload);
      setRecommendationPhase("succeeded");
      setGenerationsLeft(value => {
        const next = Math.max(0, value - 1);
        try { localStorage.setItem("yida:generations", JSON.stringify({ date: new Date().toISOString().slice(0, 10), left: next })); } catch { /* 忽略 */ }
        return next;
      });
      const savedPrompt = prompt || `${scene}穿搭推荐`;
    setHistory(current => [{ id: Date.now().toString(), scene, prompt: savedPrompt, result: {}, createdAt: Date.now() }, ...current].slice(0, 10));
    const historyRecs = (payload.recommendations || []).map(rec => ({
      id: rec.id, title: rec.title, score: rec.score, reason: rec.reason, itemIds: rec.itemIds,
      items: rec.items.map(item => ({ id: item.id, name: item.name, category: item.category, colorName: item.colorName, season: item.season, style: item.style, imageUrl: item.imageUrl })),
    }));
    requestJson("/api/outfits/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene, prompt: savedPrompt, result: { recommendations: historyRecs } }),
      timeoutMs: 15_000,
    }).catch(() => undefined);
    } catch (error) {
      window.sessionStorage.removeItem(lastRecommendationTaskKey);
      setRecommendationPhase("failed");
      notify(error instanceof Error ? error.message : "搭配生成失败，请稍后重试");
    } finally {
      outfitJobActiveRef.current = false;
    }
  };

  const handleModelUpload = async (files: FileList | null) => {
    const image = files?.[0];
    if (!image || !image.type.startsWith("image/")) return;
    setModelUploading(true);
    try {
      const form = new FormData();
      form.append("image", image, image.name || "full-body.jpg");
      const { data: payload } = await requestJson<{ profile: ModelProfile }>("/api/model-profile", { method: "POST", body: form, timeoutMs: 45_000 });
      tryOnCacheRef.current.forEach(url => URL.revokeObjectURL(url));
      tryOnCacheRef.current.clear();
      tryOnPreviewJobRef.current = "";
      replaceTryOnQuickUrl();
      setTryOnUrl("");
      setModelProfile(payload.profile);
      notify("个人模特已准备好");
    } catch (error) {
      notify(error instanceof Error ? error.message : "全身照保存失败");
    } finally {
      setModelUploading(false);
      if (modelFileRef.current) modelFileRef.current.value = "";
    }
  };

  const generateTryOn = async (recommendationOverride?: OutfitRecommendation, persistTask = true) => {
    const recommendation = Array.isArray(recommendationOverride?.itemIds)
      ? recommendationOverride
      : recommendations.find(item => item.id === selectedRecommendationId);
    if (!recommendation) { notify("请先选择一套搭配"); return false; }
    if (!modelProfile) { modelFileRef.current?.click(); return false; }
    if (tryOnJobActiveRef.current) { setShowTryOn(true); notify("高清效果图仍在生成，可以先看搭配速览"); return false; }
    const cacheKey = tryOnCacheKey(recommendation.itemIds);
    setTryOnContext({
      itemIds: recommendation.itemIds,
      title: recommendation.title,
      scene,
      recommendationId: persistTask ? recommendation.id : undefined,
    });
    const cachedUrl = tryOnCacheRef.current.get(cacheKey);
    if (cachedUrl) {
      replaceTryOnQuickUrl();
      setTryOnUrl(cachedUrl);
      setShowTryOn(true);
      setTryOnPhase("succeeded");
      return true;
    }
    tryOnJobActiveRef.current = true;
    setTryOnUrl("");
    replaceTryOnQuickUrl();
    setShowTryOn(true);
    setTryOnPhase("submitting");
    let taskId = "";
    try {
      taskId = createIdempotencyKey();
      startTryOnQuickPreview(taskId, recommendation.items, recommendation.title);
      if (persistTask) {
        window.sessionStorage.setItem(lastVisualizationTaskKey, taskId);
        window.sessionStorage.setItem(lastVisualizationLookKey, recommendation.id);
      } else {
        window.sessionStorage.removeItem(lastVisualizationTaskKey);
        window.sessionStorage.removeItem(lastVisualizationLookKey);
      }
      const form = new FormData();
      form.append("itemIds", JSON.stringify(recommendation.itemIds));
      form.append("title", recommendation.title);
      form.append("scene", scene);
      form.append("prompt", prompt);
      setTryOnPhase("running");
      const resultUrl = URL.createObjectURL(await submitVisualizationTask(taskId, form));
      tryOnPreviewJobRef.current = "";
      tryOnCacheRef.current.set(cacheKey, resultUrl);
      setTryOnUrl(resultUrl);
      setTryOnPhase("succeeded");
      return true;
    } catch (error) {
      if (taskId) {
        window.sessionStorage.removeItem(lastVisualizationTaskKey);
        window.sessionStorage.removeItem(lastVisualizationLookKey);
      }
      setTryOnPhase("failed");
      setShowTryOn(false);
      notify(error instanceof Error ? error.message : "效果图生成失败");
      return false;
    } finally {
      tryOnJobActiveRef.current = false;
    }
  };

  const retrySavedOutfit = async (outfit: SavedOutfit) => {
    const recommendation: OutfitRecommendation = {
      id: `saved-${outfit.id}`,
      title: outfit.title || "我的收藏搭配",
      reason: "来自你的收藏，点击生成完整效果图",
      score: 0,
      itemIds: outfit.itemIds,
      items: outfit.items.map(item => ({
        id: item.id,
        name: item.name,
        category: item.category,
        colorName: item.colorName,
        season: "四季",
        style: "简约",
        imageUrl: item.imageUrl,
      })),
      highlights: [],
    };
    setRecommendations(current => {
      const filtered = current.filter(rec => rec.id !== recommendation.id);
      return [recommendation, ...filtered];
    });
    setSelectedRecommendationId(recommendation.id);
    setShowResults(true);
    setScene(outfit.scene as Scene);
    setTab("home");
    await generateTryOn(recommendation);
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    if (uploadJobActiveRef.current) {
      notify("请勿重复提交，当前照片仍在处理中");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    const selected = Array.from(files).filter(file => file.type.startsWith("image/")).slice(0, 5);
    if (!selected.length) return;
    // 从虚拟衣柜发起上传时，真实衣物应立即回到“我的衣柜”中展示。
    if (activeCloset !== "own") {
      resetClosetScopedState();
      setActiveCloset("own");
    }
    uploadJobActiveRef.current = true;
    const mode = uploadModeRef.current;
    uploadModeRef.current = "replace";
    const batchId = ++uploadBatchRef.current;
    setTab("wardrobe");
    setUploadOpen(true);
    setUploadProcessing(true);
    setUploadBackgroundPending(false);
    setUploadProgress(0);
    setUploadTotal(selected.length);
    const sourcePreviewUrls = selected.map(file => URL.createObjectURL(file));
    setUploadPhotoPreviews(current => {
      current.forEach(url => URL.revokeObjectURL(url));
      return sourcePreviewUrls;
    });
    if (mode === "replace") {
      setGarmentDrafts(current => {
        current.forEach(item => { URL.revokeObjectURL(item.previewUrl); URL.revokeObjectURL(item.originalUrl); });
        return [];
      });
    }
    try {
      let completed = 0;
      const reconstructionJobs: Array<Promise<void>> = [];
      const registeredReconstructionKeys = new Set<string>();
      const publishProcessedItems = (items: ProcessedGarmentImage[]) => {
        if (uploadBatchRef.current !== batchId) {
          items.forEach(item => { URL.revokeObjectURL(item.previewUrl); URL.revokeObjectURL(item.originalUrl); });
          return [];
        }
        const incoming = items.map(garmentDraftFromProcessed);
        setGarmentDrafts(current => {
          const incomingByKey = new Map(incoming.map(item => [item.draftKey, item]));
          const retiredUrls = current.flatMap(item => {
            const replacement = incomingByKey.get(item.draftKey);
            if (!replacement) return [];
            return [
              item.previewUrl !== replacement.previewUrl ? item.previewUrl : "",
              item.originalUrl !== replacement.originalUrl ? item.originalUrl : "",
            ].filter(Boolean);
          });
          if (retiredUrls.length) window.setTimeout(() => retiredUrls.forEach(url => URL.revokeObjectURL(url)), 0);
          return mergeGarmentDrafts(current, incoming);
        });
        return incoming;
      };
      const tasks = selected.map(async (file, fileIndex) => {
        try {
          const processedItems = await processGarmentUpload(file, {
            combinedAtlas: selected.length >= 3,
            sourceKey: `batch:${batchId}:photo:${fileIndex}`,
            onPreview: publishProcessedItems,
          });
          const newDrafts = publishProcessedItems(processedItems);
          for (const draft of newDrafts) {
            if (!draft.reconstructionTask || registeredReconstructionKeys.has(draft.draftKey)) continue;
            registeredReconstructionKeys.add(draft.draftKey);
            reconstructionJobs.push(draft.reconstructionTask.then(outcome => {
              if (uploadBatchRef.current !== batchId) return;
              if (outcome.status === "failed") {
                setGarmentDrafts(current => current.map(item => item.draftKey === draft.draftKey ? {
                  ...item,
                  selected: false,
                  cutoutQuality: "failed",
                  completionStatus: "failed",
                  reconstructionTask: undefined,
                } : item));
                return;
              }
              const previewUrl = URL.createObjectURL(outcome.blob);
              setGarmentDrafts(current => current.map(item => item.draftKey === draft.draftKey ? {
                ...item,
                blob: outcome.blob,
                previewUrl,
                selected: false,
                cutoutQuality: "review",
                completionStatus: "ready",
                productOrigin: "ai-reconstructed",
                reconstructionTask: undefined,
              } : item));
              window.setTimeout(() => URL.revokeObjectURL(draft.previewUrl), 0);
            }));
          }
          return processedItems;
        } finally {
          completed += 1;
          if (uploadBatchRef.current === batchId) setUploadProgress(completed);
        }
      });
      const settled = await Promise.allSettled(tasks);
      if (uploadBatchRef.current !== batchId) return;
      setUploadPhotoPreviews(current => {
        current.forEach(url => URL.revokeObjectURL(url));
        return [];
      });
      const failedCount = settled.filter(result => result.status === "rejected").length;
      if (failedCount) notify(`${failedCount} 张图片未识别到可入柜的单品，其他图片已完成`);
      setUploadProcessing(false);
      if (reconstructionJobs.length) {
        setUploadBackgroundPending(true);
        await Promise.allSettled(reconstructionJobs);
        if (uploadBatchRef.current === batchId) setUploadBackgroundPending(false);
      }
    } catch {
      if (uploadBatchRef.current === batchId) notify("图片处理失败，请换一张清晰照片再试");
    } finally {
      if (uploadBatchRef.current === batchId) {
        uploadJobActiveRef.current = false;
        setUploadProcessing(false);
        setUploadBackgroundPending(false);
        setUploadPhotoPreviews(current => {
          current.forEach(url => URL.revokeObjectURL(url));
          return [];
        });
      }
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const updateGarmentDraft = (id: string, patch: Partial<GarmentDraft>) => {
    setGarmentDrafts(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const closeUpload = () => {
    uploadBatchRef.current += 1;
    // The invalidated batch may keep consuming network work in the background,
    // but every callback checks batchId before publishing. Release the UI lock
    // now so closing a slow refinement never blocks the next upload.
    uploadJobActiveRef.current = false;
    garmentDrafts.forEach(item => { URL.revokeObjectURL(item.previewUrl); URL.revokeObjectURL(item.originalUrl); });
    uploadPhotoPreviews.forEach(url => URL.revokeObjectURL(url));
    setGarmentDrafts([]);
    setUploadPhotoPreviews([]);
    setUploadProcessing(false);
    setUploadBackgroundPending(false);
    setUploadOpen(false);
  };

  const saveGarmentDrafts = async () => {
    const incompleteSelected = garmentDrafts.filter(item => item.selected && ["generating", "failed"].includes(item.completionStatus));
    if (incompleteSelected.length) { notify("请等完整商品图生成后再加入衣柜"); return; }
    const selected = garmentDrafts.filter(item => item.selected);
    if (!selected.length) { notify("请至少选择一件衣物"); return; }
    setUploadSaving(true);
    const saved = new Array<WardrobeItem | null>(selected.length).fill(null);
    const errors = new Array<string | null>(selected.length).fill(null);
    try {
      let nextIndex = 0;
      async function saveWorker() {
        while (nextIndex < selected.length) {
          const index = nextIndex++;
          const draft = selected[index];
          const form = new FormData();
          const extension = draft.blob.type === "image/jpeg" ? "jpg" : "png";
          form.append("image", draft.blob, `${draft.id}.${extension}`);
          form.append("name", draft.name);
          form.append("category", draft.category);
          form.append("colorName", draft.colorName);
          form.append("colorHex", draft.colorHex);
          form.append("season", draft.season);
          form.append("style", draft.style);
          form.append("aiTags", JSON.stringify(draft.aiTags));
          try {
            const { data: payload } = await requestJson<{ item: WardrobeItem }>("/api/wardrobe", { method: "POST", body: form, timeoutMs: 45_000 });
            saved[index] = payload.item;
          } catch (error) {
            errors[index] = error instanceof Error ? error.message : "保存失败";
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, selected.length) }, () => saveWorker()));
      const completed = saved.filter((item): item is WardrobeItem => item !== null);
      if (completed.length) setWardrobeItems(current => [...completed, ...current]);
      const failedCount = errors.filter(Boolean).length;
      if (!failedCount) {
        closeUpload();
        notify(`${completed.length} 件衣物已加入衣柜`);
      } else {
        const completedIds = new Set(selected.filter((_, index) => saved[index]).map(item => item.id));
        selected.forEach((item, index) => {
          if (saved[index]) {
            URL.revokeObjectURL(item.previewUrl);
            URL.revokeObjectURL(item.originalUrl);
          }
        });
        setGarmentDrafts(current => current.filter(item => !completedIds.has(item.id)));
        notify(`${completed.length} 件已加入，${failedCount} 件保存失败，请重试`);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败，请稍后重试");
    } finally {
      setUploadSaving(false);
    }
  };

  const activateStarterWardrobe = async (genderOverride?: "女" | "男") => {
    if (starterLoading) return;
    const targetGender = genderOverride || (profile.gender === "男" ? "男" : "女");
    const targetCloset = targetGender === "男" ? "male" : "female";
    const targetStarterItems = wardrobeItems.filter(item => item.aiTags?.starterGender === targetGender);
    const targetStarterKeys = new Set(targetStarterItems.map(item => item.aiTags?.starterId || item.name));
    const hasCompleteTargetWardrobe = targetStarterItems.length === targetStarterKeys.size
      && targetStarterKeys.size === STARTER_WARDROBE_SIZE_PER_GENDER;
    if (activeCloset === targetCloset && hasCompleteTargetWardrobe) {
      setShowStarterPicker(false);
      return;
    }
    // 目标虚拟衣柜已完整就直接切换；数量不足或有重复时交给服务端补齐。
    if (hasCompleteTargetWardrobe) {
      resetClosetScopedState();
      setActiveCloset(targetCloset);
      setShowStarterPicker(false);
      notify(`已切换到${targetGender === "男" ? "男生" : "女生"}虚拟衣柜`);
      return;
    }
    setStarterLoading(true);
    setShowStarterPicker(false);
    notify(targetGender === "男" ? "正在准备男生示例衣柜…" : "正在准备女生示例衣柜…");
    try {
      const { data: payload } = await requestJson<{ saved: number; added?: number; failed?: number; catalogSize?: number; reused?: boolean }>("/api/wardrobe/starter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gender: targetGender }),
        timeoutMs: 240_000,
      });
      // 无论新建还是复用，都整体刷新衣柜后切到对应视图
      const fresh = await requestJson<{ items?: WardrobeItem[] }>("/api/wardrobe", { timeoutMs: 20_000 });
      setWardrobeItems(fresh.data.items || []);
      resetClosetScopedState();
      setActiveCloset(targetCloset);
      const closetName = `${targetGender === "男" ? "男生" : "女生"}虚拟衣柜`;
      if (payload.failed) {
        notify(`${closetName}已就绪 ${payload.saved}/${payload.catalogSize || STARTER_WARDROBE_SIZE_PER_GENDER} 件，${payload.failed} 件可稍后重试`);
      } else if ((payload.added || 0) > 0 && (payload.added || 0) < payload.saved) {
        notify(`${closetName}已补齐 ${payload.added} 件，共 ${payload.saved} 件`);
      } else {
        notify(payload.reused ? `已切换到${closetName}` : `${closetName}已准备好，共 ${payload.saved} 件`);
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : "预设衣柜暂时没有准备好，请稍后重试");
    } finally {
      setStarterLoading(false);
    }
  };

  const openStarterPicker = () => {
    if (starterLoading) return;
    // 始终先让用户明确选择，避免默认值猜错；同时展示当前状态与“切回我的衣柜”
    setShowStarterPicker(true);
  };

  const removeStarterWardrobe = () => {
    // 切回“我的衣柜”视图：预设单品保留在库里（随时可再切回），仅隐藏
    setShowStarterPicker(false);
    if (activeCloset === "own") return;
    resetClosetScopedState();
    setActiveCloset("own");
    notify(ownGarmentCount ? `已切回你的衣柜（${ownGarmentCount} 件自己的衣服）` : "已切回你的衣柜，可以上传自己的衣服了");
  };

  const openVirtualWardrobe = () => {
    const targetGender = activeCloset === "male" ? "男" : activeCloset === "female" ? "女" : profile.gender === "男" ? "男" : "女";
    void activateStarterWardrobe(targetGender);
  };

  const updateWardrobeItem = async (id: string, patch: Partial<WardrobeItem>) => {
    try {
      const { data: payload } = await requestJson<{ item: WardrobeItem }>("/api/wardrobe", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }), timeoutMs: 20_000 });
      setWardrobeItems(current => current.map(item => item.id === id ? payload.item : item));
      setEditingWardrobe(null);
      notify("衣物信息已更新");
    } catch (error) {
      notify(error instanceof Error ? error.message : "更新失败");
    }
  };

  const deleteWardrobeItem = async (item: WardrobeItem) => {
    if (!window.confirm(`确定从衣柜删除“${item.name}”吗？`)) return;
    setWardrobeItems(current => current.filter(value => value.id !== item.id));
    notify("衣物已从衣柜删除");
    try {
      await requestJson(`/api/wardrobe?id=${encodeURIComponent(item.id)}`, { method: "DELETE", timeoutMs: 20_000 });
    } catch (error) {
      setWardrobeItems(current => current.some(value => value.id === item.id)
        ? current
        : [...current, item].sort((a, b) => b.createdAt - a.createdAt));
      notify(error instanceof Error ? `${error.message}，衣物已恢复` : "删除失败，衣物已恢复");
    }
  };

  const handleSwapRequest = (text: string, surface: "results" | "tryon" = "results") => {
    setChatTyping(true);
    const category = parseSwapCategory(text);
    if (!category) {
      const handled = surface === "results" && handleStyleAdjustment(text);
      if (!handled) {
        if (/更正式|正式一点|商务/.test(text)) {
          setChatMessages(current => [...current, { role: "assistant", text: "衣柜里暂时没有更正式的同类别单品可以替换，先上传几件西装、皮鞋或通勤衬衫吧。" }]);
        } else if (/休闲一点|更休闲|随意/.test(text)) {
          setChatMessages(current => [...current, { role: "assistant", text: "衣柜里暂时没有更休闲的同类别单品可以替换，试试说「换鞋」「换外套」手动挑一件。" }]);
        } else if (/颜色再克制|颜色克制|更低调|更素/.test(text)) {
          setChatMessages(current => [...current, { role: "assistant", text: "衣柜里暂时没有更素色（黑/白/灰/米/棕）的同类别单品可以替换，也可以说「换上衣」手动挑一件。" }]);
        } else {
          setChatMessages(current => [...current, { role: "assistant", text: "你可以说「换鞋」「换外套」「换上装」「换帽子」等，我会从你的衣柜里找替换单品。" }]);
        }
      }
      setChatTyping(false);
      return;
    }
    if (surface === "tryon" ? !tryOnContext : !selectedRecommendationId) {
      setChatMessages(current => [...current, { role: "assistant", text: surface === "tryon" ? "这张效果图暂时没有可替换的单品信息。" : "请先在推荐结果里选择一套搭配，再说要换哪件。" }]);
      setChatTyping(false);
      return;
    }
    setSwapCategory(category);
    setShowSwapModal(true);
    setChatTyping(false);
  };

  const handleStyleAdjustment = (text: string): boolean => {
    const recommendation = recommendations.find(item => item.id === selectedRecommendationId);
    if (!recommendation) return false;
    const wardrobeLookup = new Map(activeItems.map(item => [item.id, item]));
    const outfitItems = recommendation.items.map(item => wardrobeLookup.get(item.id)).filter((item): item is WardrobeItem => Boolean(item));
    if (!outfitItems.length) return false;
    let replaced = false;
    if (/更正式|正式一点|商务/.test(text)) {
      const candidates = outfitItems.map(current => {
        const alternatives = activeItems.filter(item => item.status === "available" && item.category === current.category && item.id !== current.id && item.aiTags.formality > current.aiTags.formality).sort((a, b) => b.aiTags.formality - a.aiTags.formality);
        return { current, next: alternatives[0] };
      }).filter(entry => entry.next);
      const best = candidates.sort((a, b) => b.next.aiTags.formality - a.next.aiTags.formality)[0];
      if (best) { applyItemSwap(best.current.category, best.next); replaced = true; }
    } else if (/休闲一点|更休闲|随意/.test(text)) {
      const candidates = outfitItems.map(current => {
        const alternatives = activeItems.filter(item => item.status === "available" && item.category === current.category && item.id !== current.id && item.aiTags.formality < current.aiTags.formality).sort((a, b) => a.aiTags.formality - b.aiTags.formality);
        return { current, next: alternatives[0] };
      }).filter(entry => entry.next);
      const best = candidates.sort((a, b) => a.next.aiTags.formality - b.next.aiTags.formality)[0];
      if (best) { applyItemSwap(best.current.category, best.next); replaced = true; }
    } else if (/颜色再克制|颜色克制|更低调|更素/.test(text)) {
      const neutralFamilies = ["黑色", "白色", "灰色", "米色", "棕色"];
      const candidates = outfitItems.map(current => {
        const alternatives = activeItems.filter(item => item.status === "available" && item.category === current.category && item.id !== current.id && neutralFamilies.includes(item.aiTags.colorFamily));
        return { current, next: alternatives[0] };
      }).filter(entry => entry.next);
      const colorful = candidates.filter(entry => !neutralFamilies.includes(entry.current.aiTags.colorFamily));
      const best = (colorful.length ? colorful : candidates).sort((a, b) => (b.current.aiTags.statementLevel || 2) - (a.current.aiTags.statementLevel || 2))[0];
      if (best) { applyItemSwap(best.current.category, best.next); replaced = true; }
    }
    return replaced;
  };

  const applyItemSwap = (category: string, newItem: WardrobeItem) => {
    setRecommendations(current => current.map(rec => {
      if (rec.id !== selectedRecommendationId) return rec;
      const items = replaceOutfitCategory(rec.items, category, newItem);
      return { ...rec, items, itemIds: items.map(item => item.id) };
    }));
    setShowSwapModal(false);
    setChatMessages(current => [...current, { role: "assistant", text: `已把${category}换成「${newItem.name}」，需要的话可以再调整或重新生成效果图。` }]);
  };

  const sendChat = () => {
    const value = chatInput.trim();
    if (!value) return;
    setChatMessages(current => [...current, { role: "user", text: value }]);
    setChatInput("");
    handleSwapRequest(value);
  };

  const sendTryOnChat = () => {
    const value = tryOnChatInput.trim();
    if (!value) return;
    setChatMessages(current => [...current, { role: "user", text: value }]);
    setTryOnChatInput("");
    handleSwapRequest(value, "tryon");
  };

  const swapTryOnItem = async (newItem: WardrobeItem) => {
    if (!tryOnContext || tryOnJobActiveRef.current) return;
    const previousContext = tryOnContext;
    const previousTryOnUrl = tryOnUrl;
    const previousSelectedItems = selectedItems;
    const sourceRecommendation = tryOnContext.recommendationId
      ? recommendations.find(item => item.id === tryOnContext.recommendationId)
      : tryOnContext.title === "我的自主搭配"
        ? undefined
        : recommendations.find(item => item.id === selectedRecommendationId);
    const wardrobeLookup = new Map(wardrobeItems.map(item => [item.id, item]));
    const baseItems = tryOnContext.itemIds.map(id =>
      sourceRecommendation?.items.find(item => item.id === id)
        || (wardrobeLookup.get(id) ? outfitItemFromWardrobe(wardrobeLookup.get(id)!) : undefined),
    ).filter((item): item is OutfitRecommendation["items"][number] => Boolean(item));
    if (!baseItems.length) {
      notify("这套搭配的单品信息暂时无法读取");
      return;
    }
    const items = replaceOutfitCategory(baseItems, swapCategory, newItem);
    const itemIds = items.map(item => item.id);
    const nextReason = `已将${swapCategory}换成「${newItem.name}」，其余单品保持不变。`;
    const nextRecommendation: OutfitRecommendation = sourceRecommendation
      ? { ...sourceRecommendation, reason: nextReason, items, itemIds }
      : {
          id: "tryon-custom",
          title: tryOnContext.title,
          reason: nextReason,
          score: 0,
          itemIds,
          items,
          highlights: [],
        };

    if (sourceRecommendation) {
      setRecommendations(current => current.map(item => item.id === sourceRecommendation.id ? nextRecommendation : item));
    } else {
      setSelectedItems(itemIds);
    }
    setTryOnContext(current => current ? { ...current, itemIds } : current);
    setShowSwapModal(false);
    setChatMessages(current => [...current, { role: "assistant", text: `已选择「${newItem.name}」，正在重新生成效果图。` }]);
    notify(`已换成「${newItem.name}」`);
    const generated = await generateTryOn(nextRecommendation, Boolean(sourceRecommendation));
    if (generated) return;
    if (sourceRecommendation) {
      setRecommendations(current => current.map(item => item.id === sourceRecommendation.id ? sourceRecommendation : item));
    } else {
      setSelectedItems(previousSelectedItems);
    }
    setTryOnContext(previousContext);
    setTryOnUrl(previousTryOnUrl);
    setTryOnPhase(previousTryOnUrl ? "succeeded" : "failed");
    setShowTryOn(Boolean(previousTryOnUrl));
    notify(previousTryOnUrl ? "新效果图暂时没有生成成功，已保留原图" : "新效果图暂时没有生成成功");
  };

  const swapItem = (itemId: string) => {
    const newItem = activeItems.find(item => item.id === itemId);
    if (!newItem) return;
    applyItemSwap(swapCategory, newItem);
  };

  const locateWeather = () => {
    if (!navigator.geolocation) { notify("当前设备不支持定位，请选择常驻城市"); return; }
    navigator.geolocation.getCurrentPosition(async position => {
      try {
        const { data: payload } = await requestJson<WeatherContext>(`/api/weather?city=${encodeURIComponent(city)}&lat=${position.coords.latitude}&lon=${position.coords.longitude}`, { timeoutMs: 15_000 });
        setWeather(payload);
        setShowWeather(false);
        notify("已根据当前位置更新天气");
      } catch { notify("天气暂时没有更新成功"); }
    }, () => notify("定位未授权，请选择常驻城市"), { enableHighAccuracy: false, timeout: 8000 });
  };

  const closeTryOn = () => {
    setShowTryOn(false);
    setShowSwapModal(false);
    setTryOnChatInput("");
  };

  const openTryOnMaterials = (category: string) => {
    if (!tryOnContext) return;
    setSwapCategory(category);
    setShowSwapModal(true);
  };

  const openWardrobeForSwap = () => {
    const targetCategory = swapCategory;
    closeTryOn();
    setTab("wardrobe");
    setClosetFilter(targetCategory || "全部");
  };

  const filters = ["全部", "清洗中", "上衣", "外套", "下装", "连衣裙", "鞋履", "配饰", "帽子"];
  const tryOnSwapCandidates = swapCategory
    ? activeItems.filter(item => item.status === "available" && item.category === swapCategory && !tryOnContext?.itemIds.includes(item.id))
    : [];
  const filteredWardrobe = closetFilter === "全部" ? activeItems : closetFilter === "清洗中" ? activeItems.filter(item => item.status === "washing") : activeItems.filter(item => item.category === closetFilter);
  const inspirationGender: InspirationGender = profile.gender === "男" ? "male" : "female";
  const inspirationGenderLabel = inspirationGender === "male" ? "男生灵感" : "女生灵感";
  const inspirationBatch = inspirationBrowseState.gender === inspirationGender ? inspirationBrowseState.batch : 0;
  const inspirationBatchStatus = inspirationBrowseState.gender === inspirationGender ? inspirationBrowseState.status : "";
  const currentInspirationThemes = inspirationThemes[inspirationGender];
  const inspirationBatchCount = Math.ceil(currentInspirationThemes.length / INSPIRATION_BATCH_SIZE);
  const inspirationBatchStart = inspirationBatch * INSPIRATION_BATCH_SIZE;
  const visibleInspirationThemes = currentInspirationThemes.slice(inspirationBatchStart, inspirationBatchStart + INSPIRATION_BATCH_SIZE);
  const showNextInspirationBatch = () => {
    const nextBatch = (inspirationBatch + 1) % inspirationBatchCount;
    setInspirationBrowseState({
      gender: inspirationGender,
      batch: nextBatch,
      status: `已记录这批都不喜欢，已切换到${inspirationGenderLabel}第 ${nextBatch + 1} 批`,
    });
    notify("已记录这批偏好，换一批看看");
  };
  const closetSourceLabel = activeCloset === "own" ? "我的衣柜" : activeCloset === "female" ? "女生虚拟衣柜" : "男生虚拟衣柜";
  const closetSourceDetail = activeCloset === "own"
    ? (activeItems.length ? `从你上传的 ${activeItems.length} 件衣物中搭配` : "只使用你自己上传的衣物")
    : `使用 ${activeItems.length} 件独立白底单品，不会混入我的衣柜`;
  const closetSetup = (
    <section className="home-source-setup" aria-label="衣柜快捷入口">
      <div className="home-source-options">
        <button type="button" className="home-source-option source-own" onClick={() => openUploadPicker("replace")}><span className="source-option-icon"><Icon name="wardrobe" /></span><span><b>上传我的衣柜</b><small>拍照或选图，自动拆分成单件商品图</small></span><em>去上传 <Icon name="arrow" /></em></button>
        <button type="button" className="home-source-option source-demo" onClick={openStarterPicker} disabled={starterLoading} aria-busy={starterLoading}><span className="source-option-icon"><Icon name="spark" /></span><span><b>体验虚拟衣柜</b><small>女装、男装各 {STARTER_WARDROBE_SIZE_PER_GENDER} 件白底单品，随时切换</small></span><em>{starterLoading ? "正在准备" : activeCloset === "own" ? "立即体验" : "切换衣柜"} <Icon name="arrow" /></em></button>
      </div>
    </section>
  );
  const resultsBlock = (
    <Results
      scene={scene} scope={scope} recommendations={recommendations} intent={outfitIntent}
      selectedId={selectedRecommendationId} setSelectedId={setSelectedRecommendationId}
      generateLooks={generateLooks} generateTryOn={generateTryOn} modelReady={Boolean(modelProfile)}
      openModelUpload={() => modelFileRef.current?.click()} tryOnLoading={tryOnLoading} weather={weather}
      chatMessages={chatMessages} chatInput={chatInput} setChatInput={setChatInput} sendChat={sendChat} chatTyping={chatTyping}
    />
  );

  const mobileHome = (
    <div className="screen home-screen mobile-home ai-mobile-home">
      <div className="mobile-home-atmosphere" aria-hidden="true"><i /><i /><i /></div>
      <header className="app-header ai-mobile-header"><div className="mobile-brand"><span className="mobile-brand-mark"><LayraMark /></span><div><span className="micro-label">LAYRA · DAILY STYLING</span><h2><span>LAYRA</span>，最懂你的穿搭助手。</h2><p className="mobile-home-subtitle">告诉它今天的安排和心情，剩下的搭配交给它。</p></div></div><button className="avatar" onClick={() => setTab("profile")}>{profile.nickname.slice(0, 1)}</button></header>
      <section className={`prompt-card mobile-ai-command ${prompt ? "has-prompt" : ""}`}>
        <header className="mobile-command-head"><span><Icon name="spark" /><b>和 LAYRA 对话</b></span><button className="mobile-command-weather" onClick={() => setShowWeather(true)}>{city} {weather.temperature}°</button></header>
        <div className="scene-row mobile-scene-switch"><span>场景</span>{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
        <div className="mobile-prompt-field"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="输入穿搭需求" /><span className="mobile-input-spark" aria-hidden="true"><i /><i /><i /></span></div>
        <div className="mobile-prompt-starters">{promptStarters.map(item => <button key={item} onClick={() => setPrompt(item)}>↗ {item}</button>)}</div>
        <div className={`mobile-composer-foot ${!activeItems.length ? "is-source-empty" : ""}`}>{activeItems.length > 0 && <div className="mobile-source-summary"><span><small>搭配来源</small><b>{closetSourceLabel}</b></span><button onClick={openStarterPicker}>切换</button></div>}<button className="generate-button" onClick={generateLooks} disabled={loading || !activeItems.length}>{loading ? <><span className="spinner" />搭配中</> : <>生成3套 <Icon name="arrow" /></>}</button></div>
      </section>
      {closetSetup}
      {starterLoading && <section className="starter-progress-mobile"><span className="spinner" /> 正在准备示例衣柜…</section>}
      {loading && <Thinking phase={recommendationPhase} />}
      <div className="results-anchor" />
      {showResults && resultsBlock}
    </div>
  );

  const refiningDraftCount = garmentDrafts.filter(item => item.completionStatus === "generating").length;
  const failedDraftCount = garmentDrafts.filter(item => item.completionStatus === "failed" || item.cutoutQuality === "failed").length;
  const readyDraftCount = garmentDrafts.filter(item => ["not-needed", "ready"].includes(item.completionStatus) && item.cutoutQuality !== "failed").length;
  const recognizedDraftCount = refiningDraftCount + readyDraftCount;
  const remainingPhotoCount = Math.max(0, uploadTotal - uploadProgress);
  const refinementPending = uploadBackgroundPending || refiningDraftCount > 0;

  return (
    <main className={`site-shell ${loading ? "is-thinking" : ""}`}>
      <a className="skip-link" href="#main-workspace">跳到主要内容</a>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={event => handleUpload(event.target.files)} />
      <input ref={modelFileRef} type="file" accept="image/*" hidden onChange={event => handleModelUpload(event.target.files)} />

      <aside className="desktop-sidebar">
        <div className="side-brand"><button className="side-logo" onClick={() => setTab("home")} aria-label="LAYRA 首页"><LayraMark /></button><strong>LAYRA</strong><button className="collapse-side" onClick={() => notify("移动端将自动收起侧栏")}>‹</button></div>
        <nav>
          <button className={tab === "home" ? "active primary" : "primary"} onClick={() => setTab("home")}><Icon name="spark" /><span>今日推荐</span></button>
          <button className={tab === "wardrobe" ? "active" : ""} onClick={() => setTab("wardrobe")}><Icon name="wardrobe" /><span>我的衣柜</span></button>
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}><Icon name="create" /><span>自主搭配</span></button>
          <button className={tab === "inspiration" ? "active" : ""} onClick={() => setTab("inspiration")}><Icon name="gallery" /><span>穿搭灵感</span></button>
          <button className={tab === "saved" ? "active" : ""} onClick={() => setTab("saved")}><Icon name="saved" /><span>收藏搭配</span></button>
          <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}><Icon name="profile" /><span>我的</span></button>
        </nav>
        <button className="preference-progress" onClick={() => setTab("profile")}><i><em /></i><span><b>完善穿搭偏好</b><small>已完成 {stylePrefs.length} / 6</small></span><strong>›</strong></button>
        <div className="sidebar-recent"><div><b>近期</b><button onClick={() => setTab("profile")}>⌃</button></div>{history.slice(0, 3).map(item => <button key={item.id} onClick={() => replayHistory(item)}><span>{item.prompt}</span><small>{formatHistoryDate(item.createdAt)}</small></button>)}</div>
        <div className="sidebar-bottom"><button onClick={() => notify("有问题？告诉 LAYRA 就好")}><Icon name="help" /><span>帮助与反馈</span></button><button className="side-profile" onClick={() => setTab("profile")}><span className="side-avatar">{profile.nickname.slice(0, 1)}</span><b>{profile.nickname}</b><small>{generationsLeft} 次生成额度</small></button></div>
      </aside>

      <header className="desktop-topbar">
        <div className="topbar-title"><span>{tab === "home" ? "今日搭配" : tab === "wardrobe" ? "我的衣柜" : tab === "create" ? "个人搭配" : tab === "inspiration" ? "灵感画廊" : tab === "saved" ? "收藏搭配" : "个人中心"}</span></div>
        <div className="topbar-meta"><button className="weather-pill" onClick={() => setShowWeather(true)}>☁ {weather.temperature}° {city}</button><button className="points-pill" onClick={() => setTab("profile")}>今日剩余 {generationsLeft} 次</button><button className="side-avatar" onClick={() => setTab("profile")}>{profile.nickname.slice(0, 1)}</button></div>
      </header>

      <section className="studio-surface" id="main-workspace">
        {tab === "home" && <><div ref={homeStageRef} className="desktop-home chat-home ai-home-v2" data-scene={scene}>
          <div className="ai-home-atmosphere" aria-hidden="true"><span className="fabric-light fabric-light-a" /><span className="fabric-light fabric-light-b" /><span className="thread-orbit thread-orbit-a" /><span className="thread-orbit thread-orbit-b" /><i className="signal-node signal-node-a" /><i className="signal-node signal-node-b" /><i className="signal-node signal-node-c" /></div>
          <div className="ai-home-content">
            <div className="hero-copy ai-home-intro"><span className="mode-pill"><i /> LAYRA · DAILY STYLING SESSION</span><h1><em>LAYRA</em>，最懂你的穿搭助手。</h1><p>告诉它今天的安排和心情，剩下的搭配交给它。</p></div>
            <section className={`studio-composer ai-command-card ${prompt ? "has-prompt" : ""}`}>
              <div className="ai-scene-control"><span>使用场景</span><div>{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div></div>
              <div className="ai-prompt-field"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="描述今天想要的穿搭" /><span className="input-signal" aria-hidden="true"><i /><i /><i /><i /></span></div>
              <div className="ai-composer-actions"><div className="ai-prompt-starters">{promptStarters.map(item => <button key={item} onClick={() => setPrompt(item)}><span>↗</span>{item}</button>)}</div><div className="ai-generate-zone"><small>今日还可生成 {generationsLeft} 次</small><button className="primary-generate" onClick={generateLooks} disabled={loading || !activeItems.length}>{loading ? <><span className="spinner" />正在搭配</> : <>生成3套搭配<Icon name="arrow" /></>}</button></div></div>
              {activeItems.length > 0 && <footer className="ai-command-foot"><div className="ai-outfit-source"><Icon name="wardrobe" /><span><small>搭配来源</small><b>{closetSourceLabel}</b><em>{closetSourceDetail}</em></span><button onClick={openStarterPicker}>切换来源</button></div></footer>}
            </section>
          </div>
          {closetSetup}
          {starterLoading && <section className="home-readiness"><span className="spinner" /> 正在准备示例衣柜…</section>}
          {loading && <Thinking phase={recommendationPhase} />}
          <div className="results-anchor" />
          {showResults && resultsBlock}
        </div>{mobileHome}</>}

        {tab === "wardrobe" && <div className="screen wardrobe-screen">
          <header className="sub-header wardrobe-page-header">
            <div><span className="micro-label">MY CLOSET</span><h2>{activeCloset === "own" ? "我的衣柜" : activeCloset === "female" ? "女生虚拟衣柜" : "男生虚拟衣柜"} <sup>{activeItems.length}</sup></h2><p>{activeCloset === "own" ? "把真实衣服整理好，之后的搭配才会真正属于你。" : "这里仅用于体验，示例单品不会加入或混入你的衣柜。"}</p></div>
            <div className="wardrobe-header-tools" aria-busy={starterLoading}>
              <div className="wardrobe-source-controls">
                <div className="wardrobe-mode-switch" role="group" aria-label="衣柜类型">
                  <button type="button" className={activeCloset === "own" ? "active" : ""} aria-pressed={activeCloset === "own"} onClick={removeStarterWardrobe}>我的衣柜</button>
                  <button type="button" className={activeCloset !== "own" ? "active" : ""} aria-pressed={activeCloset !== "own"} onClick={openVirtualWardrobe} disabled={starterLoading}>{starterLoading ? "准备中" : "虚拟衣柜"}</button>
                </div>
                {activeCloset !== "own" && <div className="wardrobe-gender-switch" role="group" aria-label="虚拟衣柜性别">
                  <button type="button" className={activeCloset === "female" ? "active" : ""} aria-pressed={activeCloset === "female"} onClick={() => void activateStarterWardrobe("女")} disabled={starterLoading}>女装</button>
                  <button type="button" className={activeCloset === "male" ? "active" : ""} aria-pressed={activeCloset === "male"} onClick={() => void activateStarterWardrobe("男")} disabled={starterLoading}>男装</button>
                </div>}
              </div>
              <button type="button" className="wardrobe-upload-more" onClick={() => openUploadPicker("replace")}><Icon name="create" /><span>{ownGarmentCount > 0 ? "继续上传" : "上传衣物"}</span></button>
            </div>
          </header>
          <div className="closet-status"><span><b>{activeItems.filter(item => item.status === "available").length}</b> 件可穿</span><span><b>{activeItems.filter(item => item.status === "washing").length}</b> 件清洗中</span><span><b>{new Set(activeItems.flatMap(item => garmentTagLabels(item.aiTags))).size}</b> 个AI搭配标签</span></div>
          <div className="wardrobe-toolbar"><div className="filter-row">{filters.map(filter => <button key={filter} className={closetFilter === filter ? "active" : ""} onClick={() => setClosetFilter(filter)}>{filter}</button>)}</div><span>{closetFilter === "全部" ? "全部单品" : closetFilter} · {filteredWardrobe.length}</span></div>
          {wardrobeLoading ? <div className="wardrobe-loading"><span className="spinner" /> 正在同步衣柜…</div> : filteredWardrobe.length ? <div className="wardrobe-grid saved-wardrobe-grid">
            {filteredWardrobe.map(item => <article className={`wardrobe-item saved-garment ${item.status === "washing" ? "is-washing" : ""}`} key={item.id}><div className="uploaded-wrap product-white"><img src={item.imageUrl} alt={item.name} loading="lazy" /><span className="ai-tag">{item.status === "washing" ? "清洗中" : "已入柜"}</span><i className="garment-color-dot" style={{ background: item.colorHex }} /></div><b>{item.name}</b><small>{item.colorName} · {item.category} · {item.season}</small><div className="wardrobe-ai-tags">{garmentTagLabels(item.aiTags).slice(0, 5).map(tag => <span key={tag}>{tag}</span>)}<span>正式 {item.aiTags.formality}/5</span><span>保暖 {item.aiTags.warmth}/5</span></div><div className="wardrobe-actions"><button onClick={() => setEditingWardrobe(item)}>编辑</button><button onClick={() => updateWardrobeItem(item.id, { status: item.status === "washing" ? "available" : "washing" })}>{item.status === "washing" ? "恢复可穿" : "标记清洗"}</button><button onClick={() => deleteWardrobeItem(item)}>删除</button></div></article>)}
          </div> : <section className="wardrobe-empty"><div><span>{closetFilter === "全部" ? "＋" : "○"}</span></div><h3>{closetFilter === "全部" ? "衣柜还是空的" : closetFilter === "清洗中" ? "没有清洗中的衣服" : `还没有${closetFilter}`}</h3><p>{closetFilter === "全部" ? "先上传一件常穿的衣服。LAYRA 会自动抠掉背景、识别标签，你只需要确认一下；不想现在上传，也可以先用示例衣柜体验。" : closetFilter === "清洗中" ? "在衣物卡片上点「标记清洗」，它就会出现在这里。" : "这个分类下还没有单品，可以切回全部看看。"}</p>{closetFilter === "全部" ? <div className="wardrobe-empty-actions"><button onClick={() => openUploadPicker("replace")}>上传第一件衣服</button><button className="starter-cta-desktop" onClick={openStarterPicker} disabled={starterLoading}>{starterLoading ? "正在准备…" : "⚡ 先用示例衣柜体验"}</button></div> : <div className="wardrobe-empty-actions"><button onClick={() => setClosetFilter("全部")}>查看全部衣服</button></div>}</section>}
          <section className="photo-guide"><span className="micro-label">拍得好，抠得更干净</span><div><p><b>01</b> 衣服平铺或挂直</p><p><b>02</b> 背景干净、颜色有反差</p><p><b>03</b> 光线均匀，避免明显阴影</p></div></section>
        </div>}

        {tab === "create" && <div className="screen create-screen">
          <header className="sub-header"><div><span className="micro-label">STYLE IT YOURSELF</span><h2>今天你来搭</h2></div><span className="step-chip">已选 {selectedItems.length} 件</span></header><p className="lead-copy">从你的衣柜挑出想穿的，AI 会从颜色、版型、天气与场合四个方面点评。</p>
          <div className="create-workbench">
            <section className={`canvas-card ${selectedItems.length ? "has-items" : "is-empty"}`}>
              <div className="canvas-label"><span><b>搭配画布</b><small>{selectedItems.length ? `${selectedItems.length} 件单品已放入` : "把想穿的单品放在一起比较"}</small></span><button disabled={!selectedItems.length} onClick={() => { setSelectedItems([]); setReviewResult(null); }}>清空</button></div>
              <div className="canvas-items">{selectedItems.length ? selectedItems.map(id => { const item = activeItems.find(w => w.id === id); if (!item) return null; return <button key={id} onClick={() => setSelectedItems(items => items.filter(value => value !== id))}><img src={item.imageUrl} alt={item.name} /><span className="remove-chip" aria-hidden="true">×</span><small>{item.name}</small></button>; }) : <div className="canvas-empty-state"><span className="canvas-empty-icon"><i /><i /><Icon name="create" /></span><b>先从衣柜列表选择单品</b><p>至少选 2 件，LAYRA 会一起检查配色、比例、天气与场合。</p></div>}</div>
            </section>
            <aside className="create-picker-panel">
              <div className="create-picker-head"><div><span>搭配来源</span><b>{activeItems.length ? closetSourceLabel : "还没有可选衣物"}</b><small>{activeItems.length ? activeItems.length > 6 ? `${activeItems.length} 件单品，可上下滑动查看` : `${activeItems.length} 件单品可选` : "上传自己的衣服，或先用示例单品体验"}</small></div>{activeItems.length > 0 && <button onClick={openStarterPicker}>切换</button>}</div>
              {activeItems.length ? <div className="pick-grid" role="region" aria-label="可选衣物" tabIndex={0}>{activeItems.map(item => { const active = selectedItems.includes(item.id); return <button key={item.id} className={active ? "active" : ""} onClick={() => setSelectedItems(items => active ? items.filter(id => id !== item.id) : [...items, item.id])}><img src={item.imageUrl} alt={item.name} loading="lazy" /><small>{item.category} · {item.name}</small>{active && <span className="pick-check"><Icon name="check" /></span>}</button>; })}</div> : <div className="create-source-empty"><span className="source-option-icon"><Icon name="wardrobe" /></span><b>先准备搭配单品</b><p>我的衣柜只保存你上传的真实衣物；示例衣柜用于快速体验，两者不会混在一起。</p><button onClick={() => setTab("wardrobe")}>上传我的衣物 <Icon name="arrow" /></button><button className="secondary-source-action" onClick={openStarterPicker}>使用示例衣柜</button></div>}
              <div className="create-review-bar"><span aria-live="polite">{selectedItems.length < 2 ? `还需选择 ${2 - selectedItems.length} 件` : `已选 ${selectedItems.length} 件，可以开始点评`}</span><button className="review-button" disabled={selectedItems.length < 2 || reviewLoading} onClick={reviewOutfit}><Icon name="spark" /> {reviewLoading ? "点评中…" : "点评这套搭配"}</button></div>
            </aside>
          </div>
          {reviewResult && <section className="review-panel"><div className="review-head"><span className="review-score">{reviewResult.score}<small> 分</small></span><span className="micro-label">AI OUTFIT REVIEW</span></div><div className="review-notes"><div><b>颜色协调</b><span>{reviewResult.breakdown.color}</span></div><div><b>版型比例</b><span>{reviewResult.breakdown.silhouette}</span></div><div><b>场合适配</b><span>{reviewResult.breakdown.occasion}</span></div><div><b>天气适配</b><span>{reviewResult.breakdown.weather}</span></div></div><p className="review-suggestion">{reviewResult.suggestion}</p><button className="review-button" onClick={generateTryOnForCreate}>{tryOnLoading ? "查看搭配速览（高清生成中）" : "生成 AI 试穿效果图"}</button></section>}
        </div>}

        {tab === "inspiration" && <div className="screen inspiration-screen">
          <header className="sub-header">
            <div><span className="micro-label">DISCOVER YOUR STYLE</span><h2>{inspirationGenderLabel}</h2></div>
            <span className="step-chip">{visibleInspirationThemes.length} / {currentInspirationThemes.length}</span>
          </header>
          <p className="lead-copy">喜欢或不感兴趣都会帮助 LAYRA 更懂你。收藏后可以直接用自己的衣柜复刻。</p>
          <div className="inspiration-grid">{visibleInspirationThemes.map(theme => <article className="inspiration-card" key={theme.id}>
            <button type="button" className="inspiration-visual" onClick={() => { setPrompt(`用我的衣柜复刻${theme.title}`); setTab("home"); }}>
              <img src={theme.imageUrl} alt={`${theme.title}穿搭灵感`} loading="lazy" />
              <span>用我的衣柜复刻 →</span>
            </button>
            <h3>{theme.title}</h3>
            <p>{theme.desc}</p>
            <div className="inspiration-card-actions">
              <button type="button" onClick={() => likeTheme(theme.title)}>♡ 喜欢</button>
              <button type="button" onClick={() => notify("已减少类似灵感")}>不感兴趣</button>
              <button type="button" onClick={() => saveThemeAsOutfit(theme)}>收藏</button>
            </div>
          </article>)}</div>
          <div className="inspiration-batch-bar">
            <div className="inspiration-batch-copy">
              <b>还没遇到喜欢的？</b>
              <p role="status" aria-live="polite" aria-atomic="true">{inspirationBatchStatus || `当前是第 ${inspirationBatch + 1} 批，每批 ${INSPIRATION_BATCH_SIZE} 套`}</p>
            </div>
            <div className="inspiration-batch-dots" aria-hidden="true">{Array.from({ length: inspirationBatchCount }, (_, index) => <i key={index} className={index === inspirationBatch ? "active" : ""} />)}</div>
            <button type="button" className="inspiration-batch-action" onClick={showNextInspirationBatch}>这批都不喜欢，换一批</button>
          </div>
        </div>}

        {tab === "saved" && <div className="screen saved-screen">
          <header className="sub-header"><div><span className="micro-label">SAVED LOOKS</span><h2>我的收藏</h2></div><span className="step-chip">{savedOutfits.length} 套</span></header><p className="lead-copy">你收藏的搭配都在这里，可以随时查看、删除或再次试穿。</p>
          {savedOutfits.length ? <div className="saved-list">{savedOutfits.map(outfit => <article className="saved-card" key={outfit.id}><div className="saved-card-items">{outfit.items.map(item => <img key={item.id} src={item.imageUrl} alt={item.name} />)}</div><div className="saved-card-meta"><b>{outfit.title}</b><small>{outfit.scene} · {outfit.items.length} 件 · {formatHistoryDate(outfit.createdAt)}</small></div><div className="saved-card-actions"><button className="saved-card-tryon" onClick={() => retrySavedOutfit(outfit)}>再次试穿</button><button className="saved-card-del" onClick={() => deleteSavedOutfit(outfit.id)}>删除</button></div></article>)}</div> : <section className="wardrobe-empty"><div><span>♡</span></div><h3>还没有收藏的搭配</h3><p>生成试穿效果图后，点「☆ 收藏这套搭配」就会出现在这里。</p><button onClick={() => setTab("home")}>去生成一套 →</button></section>}
        </div>}

        {tab === "profile" && <div className="screen profile-screen">
          <header className="sub-header"><div><span className="micro-label">PROFILE</span><h2>关于{profile.nickname}</h2></div><button className="edit-link" onClick={() => setShowProfileEdit(true)}>编辑资料</button></header>
          <div className="profile-overview-grid"><section className="profile-hero"><div className="big-avatar">{profile.nickname.slice(0, 1)}</div><div><h3>{profile.nickname}</h3><p>已保存的资料与偏好，会参与每次搭配推荐。</p><div className="profile-summary-chips"><span>{city}</span><span>{stylePrefs.length} 项风格偏好</span></div></div></section><ModelProfileStrip profile={modelProfile} uploading={modelUploading} onUpload={() => modelFileRef.current?.click()} /></div>
          <div className="profile-body-style-grid"><section className="body-card"><header><span>身形资料</span><small>用于判断版型与比例</small></header><div><span>性别</span><b>{profile.gender}</b></div><div><span>身高</span><b>{profile.height}<small> cm</small></b></div><div><span>体重</span><b>{profile.weight}<small> kg</small></b></div><div><span>身材比例</span><b>{profile.bodyType}</b></div></section><section className="taste-card"><span className="micro-label">STYLE DNA</span><h3>你的风格偏好</h3><p className="taste-help">点选喜欢的风格，LAYRA 会优先按这些方向推荐。</p><div className="preference-chips">{styleOptions.map(item => <button key={item} className={stylePrefs.includes(item) ? "active" : ""} onClick={() => toggleStyle(item)}>{stylePrefs.includes(item) ? "✓ " : "+ "}{item}</button>)}</div></section></div>
          <div className="profile-feature-grid"><section className="usage-card"><div><span>今日生成额度</span><b>{generationsLeft} / 5</b></div><div className="usage-track"><i style={{ width: `${generationsLeft * 20}%` }} /></div><small>每日 00:00 自动恢复</small></section><section className="points-card"><span>LAYRA 积分</span><b>260</b><small>上传衣服和完善衣柜可获得积分</small><button onClick={() => notify("积分商城将在后续版本开放")}>查看权益 →</button></section></div>
          <div className="profile-lower-grid"><section className="profile-section"><div className="section-heading"><div><span className="micro-label">HISTORY · 30 DAYS</span><h3>最近记录</h3></div><Icon name="history" /></div>{history.length ? <div className="history-list">{history.map(item => <button key={item.id} onClick={() => replayHistory(item)}><span>{formatHistoryDate(item.createdAt)}</span><b>{item.scene}</b><p>{item.prompt}</p><i>›</i></button>)}</div> : <div className="profile-history-empty"><span><Icon name="history" /></span><b>还没有搭配记录</b><p>生成第一套推荐后，这里会保留最近 30 天的记录。</p><button onClick={() => setTab("home")}>去生成搭配</button></div>}</section><section className="profile-settings"><div className="section-heading"><div><h3>账户与偏好</h3><p>管理收藏、城市与隐私设置</p></div></div><div className="settings-list"><button onClick={() => setTab("saved")}>我的收藏 <span>{savedOutfits.length} 套 ›</span></button><button onClick={() => setShowWeather(true)}>常驻城市 <span>{city} ›</span></button><button onClick={() => notify("当前使用邀请码登录")}>登录方式 <span>邀请码 ›</span></button><button onClick={() => notify("照片仅用于生成你的专属效果图")}>照片与隐私 <span>已授权 ›</span></button><button className="logout-setting" onClick={() => void logout()}>退出登录 <span>→</span></button></div></section></div>
        </div>}
      </section>

      <BottomNav tab={tab} setTab={setTab} />

      {showSwapModal && !showTryOn && <ModalFrame onClose={() => setShowSwapModal(false)} panelClassName="compact-modal"><button className="modal-close" onClick={() => setShowSwapModal(false)}>×</button><span className="micro-label">从衣柜选择替换单品</span><h3>换一件{swapCategory}</h3><div className="swap-grid">{activeItems.filter(item => item.category === swapCategory).map(item => <button key={item.id} onClick={() => swapItem(item.id)}><img src={item.imageUrl} alt={item.name} /><small>{item.name}</small></button>)}{!activeItems.some(item => item.category === swapCategory) && <p className="empty-hint">当前衣柜里暂时没有{swapCategory}，切换衣柜或去上传吧</p>}</div></ModalFrame>}
      {showStarterPicker && <ModalFrame onClose={() => setShowStarterPicker(false)} panelClassName="compact-modal"><button className="modal-close" onClick={() => setShowStarterPicker(false)}>×</button><span className="micro-label">OUTFIT SOURCE</span><h3>选择搭配来源</h3><p>「我的衣柜」只放你上传的真实衣物；「虚拟衣柜」提供男女各 {STARTER_WARDROBE_SIZE_PER_GENDER} 件独立白底单品。它与真人整套的穿搭灵感分开保存，推荐时只使用当前选择的衣柜。</p><div className="starter-gender-grid"><button className={activeCloset === "own" ? "active" : ""} aria-pressed={activeCloset === "own"} onClick={removeStarterWardrobe}><b>{activeCloset === "own" ? "✓ 我的衣柜（当前）" : "我的衣柜"}</b><small>你上传的真实衣物 · 现有 {ownGarmentCount} 件</small></button><button className={activeCloset === "female" ? "active" : ""} aria-pressed={activeCloset === "female"} onClick={() => void activateStarterWardrobe("女")}><b>{activeCloset === "female" ? "✓ 女生虚拟衣柜（当前）" : "女生虚拟衣柜"}</b><small>{STARTER_WARDROBE_SIZE_PER_GENDER} 件单件女装 · 不与灵感图混用</small></button><button className={activeCloset === "male" ? "active" : ""} aria-pressed={activeCloset === "male"} onClick={() => void activateStarterWardrobe("男")}><b>{activeCloset === "male" ? "✓ 男生虚拟衣柜（当前）" : "男生虚拟衣柜"}</b><small>{STARTER_WARDROBE_SIZE_PER_GENDER} 件单件男装 · 不与灵感图混用</small></button></div></ModalFrame>}
      {showTryOn && <ModalFrame onClose={closeTryOn} panelClassName={`personal-tryon-modal ${showSwapModal ? "is-selecting-material" : ""}`}>
        <button className="modal-close" aria-label="关闭效果图" onClick={closeTryOn}>×</button>
        {tryOnLoading && tryOnQuickUrl ? <>
          <div className="personal-tryon-image is-quick-preview">
            <img src={tryOnQuickUrl} alt="人物与本次衣柜单品搭配速览" />
            <span className="quick-preview-badge"><i /> 搭配速览已就绪</span>
          </div>
          <div className="personal-tryon-copy tryon-loading-copy">
            <span className="micro-label">FAST PREVIEW · UNDER 5S</span>
            <h3>{tryOnContext?.title || "你的今日穿搭"}</h3>
            <p>先看人物与本次单品的真实速览。高清 AI 试穿仍在生成，完成后会在这里自动替换。</p>
            <div className="tryon-progress-line"><i /></div>
            <small className="tryon-background-note">可以关闭窗口继续浏览，不会中断生成。</small>
            <button onClick={closeTryOn}>先去逛逛</button>
          </div>
        </> : tryOnLoading ? <div className="tryon-progress">
          <div className="tryon-person"><span /><i /></div>
          <span className="micro-label">PERSONAL LOOK GENERATION</span>
          <h3>{tryOnPhase === "recovering" ? "正在恢复上次的效果图" : "正在整理搭配速览"}</h3>
          <p>{tryOnPhase === "recovering" ? "无需重新生成，LAYRA 正在读取上次已经提交的结果。" : "人物照和本次衣柜单品正在排版，通常一两秒就能先看到。"}</p>
          <div className="tryon-progress-line"><i /></div>
        </div> : <>
          <div className={`personal-tryon-image ${showSwapModal ? "has-material-picker" : ""}`}>
            <img src={tryOnUrl} alt="我的AI穿搭完整效果图" />
            {showSwapModal && <aside className="tryon-material-panel" aria-label={`可替换${swapCategory}`} aria-live="polite">
              <header>
                <div><span>替换素材</span><h4>选一件{swapCategory}</h4><small>选中后会立即重新生成左侧效果图</small></div>
                <button type="button" className="tryon-material-close" aria-label="收起替换素材" onClick={() => setShowSwapModal(false)}>×</button>
              </header>
              {tryOnSwapCandidates.length ? <div className="tryon-material-grid" role="list">
                {tryOnSwapCandidates.map(item => <button type="button" role="listitem" className="tryon-material-option" key={item.id} onClick={() => void swapTryOnItem(item)}>
                  <span><img src={item.imageUrl} alt="" /></span><b>{item.name}</b><small>{item.colorName} · {item.style}</small>
                </button>)}
              </div> : <div className="tryon-material-empty"><p>当前衣柜没有其他{swapCategory}可替换。</p><button type="button" onClick={openWardrobeForSwap}>去衣柜添加</button></div>}
            </aside>}
          </div>
          <div className="personal-tryon-copy">
            <span className="micro-label">YOUR OUTFIT PREVIEW</span>
            <h3>{tryOnContext?.title || recommendations.find(item => item.id === selectedRecommendationId)?.title || "你的今日穿搭"}</h3>
            <p>{recommendations.find(item => item.id === selectedRecommendationId)?.reason || "已根据你的全身照和本次衣柜单品生成。"}</p>
            <div className="tryon-swap-shortcuts" aria-label="快速替换单品">{[["换鞋", "鞋履"], ["换外套", "外套"], ["换上衣", "上衣"], ["换下装", "下装"]].map(([label, category]) => <button type="button" key={category} onClick={() => openTryOnMaterials(category)}>{label}</button>)}</div>
            <div className="tryon-chat"><input aria-label="说出想替换的穿搭单品" value={tryOnChatInput} onChange={event => setTryOnChatInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) sendTryOnChat(); }} placeholder="边看边说：换鞋 / 换外套…" /><button onClick={sendTryOnChat}>发送</button></div>
            <p className="tryon-command-status" role="status" aria-live="polite">{showSwapModal ? `已在左侧展开 ${tryOnSwapCandidates.length} 件可替换${swapCategory}` : "说出要换的单品，LAYRA 会直接展开对应衣柜素材。"}</p>
            <div className="tryon-actions"><button className="save-btn" onClick={saveCurrentOutfit} disabled={saveLoading}>{saveLoading ? "保存中…" : "☆ 收藏这套搭配"}</button><button onClick={closeTryOn}>完成</button></div>
          </div>
        </>}
      </ModalFrame>}


      {uploadOpen && <ModalFrame onClose={closeUpload} closeDisabled={uploadProcessing || uploadSaving} panelClassName="upload-modal" backdropClassName="upload-backdrop"><button className="modal-close" disabled={uploadProcessing || uploadSaving} onClick={closeUpload}>×</button><header className="upload-modal-head"><span className="micro-label">SMART WARDROBE IMPORT</span><h3>{uploadProcessing ? "LAYRA 正在识别整套搭配" : refiningDraftCount > 0 ? "LAYRA 正在逐件生成高清商品图" : readyDraftCount > 0 ? "确认后加入衣柜" : "这批照片需要重新处理"}</h3><p>{uploadProcessing ? (recognizedDraftCount ? `已识别 ${recognizedDraftCount} 件单品，还有 ${remainingPhotoCount} 张照片在扫描${failedDraftCount ? `，${failedDraftCount} 件处理失败` : ""}` : "会分别整理上衣、下装、鞋履、帽子、包和配饰") : refiningDraftCount > 0 ? `已识别 ${recognizedDraftCount} 件，还有 ${refiningDraftCount} 件正在补全完整轮廓${failedDraftCount ? `，${failedDraftCount} 件处理失败` : ""}` : readyDraftCount > 0 ? `已完成 ${readyDraftCount} 件完整单品${failedDraftCount ? `，另有 ${failedDraftCount} 件未生成完整商品图` : ""}；AI 补全的隐藏结构需要你确认` : `${failedDraftCount} 件未生成完整商品图，请换更清晰的照片重试`}</p></header>
        {(uploadProcessing || uploadBackgroundPending) && !garmentDrafts.length && <div className="cutout-progress">{uploadPhotoPreviews.length ? <div className="upload-source-preview" aria-label="照片已接收，正在识别整套搭配">{uploadPhotoPreviews.map((url, index) => <img key={url} src={url} alt={`待识别照片 ${index + 1}`} style={{ filter: "blur(4px) saturate(.72)", opacity: .78, transform: "scale(1.035)" }} />)}<i /><b>照片已接收 · 正在拆分单品</b></div> : <div className="cutout-animation"><span /><i /><b>{uploadBackgroundPending ? "完整衣物补全中" : "整套搭配识别中"}</b></div>}<p>正在从头到脚检查衣服、鞋子、帽子、包包和配饰。</p></div>}
        {uploadPhotoPreviews.length > 0 && !!garmentDrafts.length && <div className="upload-stage-strip" aria-live="polite" style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", justifyContent: "normal", gap: 10 }}><div aria-label={`本批已接收 ${uploadPhotoPreviews.length} 张照片`} style={{ maxWidth: 112, display: "flex", alignItems: "center", gap: 4, overflow: "hidden" }}>{uploadPhotoPreviews.slice(0, 3).map((url, index) => <img key={url} src={url} alt={`本批待识别照片 ${index + 1}`} style={{ width: 27, height: 36, borderRadius: 7, objectFit: "cover", filter: "blur(2.5px) saturate(.72)", opacity: .78, transform: "scale(1.02)" }} />)}{uploadPhotoPreviews.length > 3 && <em style={{ minWidth: 21, color: "#45645d", fontSize: 9, fontStyle: "normal", fontWeight: 800 }}>+{uploadPhotoPreviews.length - 3}</em>}</div><div style={{ minWidth: 0, display: "grid", gap: 3 }}><span><i />本批已接收 {uploadPhotoPreviews.length} 张</span><p>{recognizedDraftCount ? `共识别 ${recognizedDraftCount} 件 · 还有 ${remainingPhotoCount} 张在扫描` : `还有 ${remainingPhotoCount} 张在扫描`}</p></div></div>}
        {(uploadProcessing || refiningDraftCount > 0) && !!garmentDrafts.length && !uploadPhotoPreviews.length && <div className="upload-stage-strip" aria-live="polite"><span><i />已识别 {recognizedDraftCount} 件</span><p>{uploadProcessing ? `还有 ${remainingPhotoCount} 张照片在扫描` : `${refiningDraftCount} 件高清完整商品图生成中`}{failedDraftCount ? ` · ${failedDraftCount} 件失败` : ""}</p></div>}
        {!!garmentDrafts.length && <div className="draft-grid">{garmentDrafts.map(draft => <GarmentDraftCard draft={draft} key={draft.id} onUpdate={patch => updateGarmentDraft(draft.id, patch)} />)}</div>}
        {!uploadProcessing && <footer className="upload-modal-foot"><button className="secondary-upload" disabled={refinementPending || uploadSaving} onClick={() => openUploadPicker("append")}>{refinementPending ? "高清商品图生成中" : "＋ 继续添加"}</button><button className="primary-upload" disabled={refinementPending || uploadSaving || !garmentDrafts.some(item => item.selected)} onClick={saveGarmentDrafts}>{uploadSaving ? "正在加入衣柜…" : `加入衣柜（${garmentDrafts.filter(item => item.selected).length}）`}</button></footer>}
      </ModalFrame>}

      {editingWardrobe && <ModalFrame onClose={() => setEditingWardrobe(null)} panelClassName="compact-modal wardrobe-edit-modal"><button className="modal-close" onClick={() => setEditingWardrobe(null)}>×</button><span className="micro-label">EDIT GARMENT</span><h3>修改衣物信息</h3><div className="edit-garment-preview transparent-grid"><img src={editingWardrobe.imageUrl} alt={editingWardrobe.name} /></div><div className="profile-form"><label>衣物名称<input value={editingWardrobe.name} onChange={event => setEditingWardrobe({ ...editingWardrobe, name: event.target.value })} /></label><label>分类<select value={editingWardrobe.category} onChange={event => setEditingWardrobe({ ...editingWardrobe, category: event.target.value })}>{["上衣", "外套", "下装", "连衣裙", "鞋履", "配饰", "帽子"].map(value => <option key={value}>{value}</option>)}</select></label><label>颜色<input value={editingWardrobe.colorName} onChange={event => setEditingWardrobe({ ...editingWardrobe, colorName: event.target.value })} /></label><label>季节<select value={editingWardrobe.season} onChange={event => setEditingWardrobe({ ...editingWardrobe, season: event.target.value })}>{["四季", "春秋", "夏季", "冬季"].map(value => <option key={value}>{value}</option>)}</select></label><label>风格<select value={editingWardrobe.style} onChange={event => setEditingWardrobe({ ...editingWardrobe, style: event.target.value })}>{["简约", "通勤", "休闲", "运动", "复古", "甜酷"].map(value => <option key={value}>{value}</option>)}</select></label></div><div className="edit-ai-tags-wrap"><span className="micro-label">AI MATCHING TAGS</span><div className="edit-ai-tags">{garmentTagLabels(editingWardrobe.aiTags).map(tag => <span key={tag}>{tag}</span>)}<span>正式度 {editingWardrobe.aiTags.formality}/5</span><span>保暖度 {editingWardrobe.aiTags.warmth}/5</span></div><small>用于天气、场合、层次与风格筛选，后续由搭配模型综合评分。</small></div><button className="primary-modal-button" onClick={() => updateWardrobeItem(editingWardrobe.id, editingWardrobe)}>保存修改</button></ModalFrame>}

      {showWeather && <ModalFrame onClose={() => setShowWeather(false)} panelClassName="compact-modal"><button className="modal-close" onClick={() => setShowWeather(false)}>×</button><span className="micro-label">WEATHER & LOCATION</span><h3>天气与城市</h3><p>允许定位后会自动获取当前位置；拒绝定位时使用常驻城市。天气会在后台参与搭配，不需要重复填写。</p><button className="location-button" onClick={locateWeather}>⌖ 允许定位并获取天气</button><div className="city-grid">{["杭州", "上海", "北京", "广州", "深圳", "成都"].map(item => <button key={item} className={city === item ? "active" : ""} onClick={() => { setCity(item); setShowWeather(false); notify(`常驻城市已设为${item}`); }}>{item}</button>)}</div></ModalFrame>}

      {showProfileEdit && <ModalFrame onClose={() => setShowProfileEdit(false)} panelClassName="compact-modal profile-edit-modal"><button className="modal-close" onClick={() => setShowProfileEdit(false)}>×</button><span className="micro-label">EDIT PROFILE</span><h3>编辑个人信息</h3><div className="profile-form"><label>昵称<input value={profile.nickname} onChange={event => setProfile(value => ({ ...value, nickname: event.target.value }))} /></label><label>性别<select value={profile.gender} onChange={event => setProfile(value => ({ ...value, gender: event.target.value }))}><option>女</option><option>男</option><option>其他</option></select></label><label>身高（cm）<input value={profile.height} onChange={event => setProfile(value => ({ ...value, height: event.target.value }))} /></label><label>体重（kg）<input value={profile.weight} onChange={event => setProfile(value => ({ ...value, weight: event.target.value }))} /></label><label>身材比例<select value={profile.bodyType} onChange={event => setProfile(value => ({ ...value, bodyType: event.target.value }))}><option>直筒型</option><option>梨形</option><option>苹果型</option><option>沙漏型</option><option>倒三角</option></select></label></div><button className="optional-photo" onClick={() => modelFileRef.current?.click()}>＋ {modelProfile ? "更换个人全身照" : "上传个人全身照"}</button><button className="primary-modal-button" onClick={() => { saveProfile(profile, stylePrefs); setShowProfileEdit(false); notify("个人信息已保存"); }}>保存资料</button></ModalFrame>}
      {toast && <div className="toast"><Icon name="check" /> {toast}</div>}
    </main>
  );
}

function GarmentDraftCard({
  draft,
  onUpdate,
}: {
  draft: GarmentDraft;
  onUpdate: (patch: Partial<GarmentDraft>) => void;
}) {
  const generating = draft.completionStatus === "generating";
  const failed = draft.completionStatus === "failed" || draft.cutoutQuality === "failed";
  const aiReady = draft.completionStatus === "ready" && draft.productOrigin === "ai-reconstructed";
  const disabled = generating || failed;
  const stateLabel = generating
    ? "已识别 · 生成中"
    : failed
      ? "补全失败"
      : draft.selected
        ? "✓ 已选择"
        : aiReady
          ? "点击确认"
          : "点击选择";
  const previewNotice = generating
    ? `已识别为${draft.category}，正在生成高清完整商品图`
    : failed
      ? "未生成完整商品图，请换清晰照片"
      : aiReady
        ? "AI 已补全隐藏部分，请确认版型与图案"
        : draft.cutoutQuality === "review"
          ? "原图信息不足，请谨慎确认"
          : "";
  const providerLabel = draft.cutoutProvider === "comfyui-birefnet"
    ? "本地 ComfyUI"
    : draft.cutoutProvider === "volcengine-imagex-productv2"
      ? "ImageX 商品模型"
    : draft.cutoutProvider === "aliyun-viapi"
      ? "云端抠图"
      : "";
  const qualityLabel = generating
    ? "低清识别预览 · 清晰图生成中"
    : failed
      ? "未生成完整商品图"
      : aiReady
        ? "AI 补全 · 待确认"
        : draft.cutoutQuality === "good"
          ? `完整白底商品图${providerLabel ? ` · ${providerLabel}` : ""}`
          : "待人工确认";

  return <article className={`garment-draft ${draft.selected ? "selected" : ""} quality-${draft.cutoutQuality} completion-${draft.completionStatus}`}>
    <button
      type="button"
      className="draft-select-toggle"
      disabled={disabled}
      aria-pressed={draft.selected}
      aria-label={`${draft.name}，${draft.selected ? "取消加入衣柜" : "选择加入衣柜"}`}
      onClick={() => onUpdate({ selected: !draft.selected })}
    >
      <span className="draft-state">{stateLabel}</span>
      <div className="draft-preview product-white">
        <img src={draft.previewUrl} alt={draft.name} style={generating ? { filter: "blur(2.2px) saturate(.82)", opacity: .72, transform: "scale(1.025)" } : undefined} />
        {previewNotice && <span>{previewNotice}</span>}
        {generating && <i className="draft-reconstruction-scan" aria-hidden="true" />}
      </div>
    </button>
    <label>衣物名称<input disabled={generating} value={draft.name} onChange={event => onUpdate({ name: event.target.value })} /></label>
    <div className="draft-fields">
      <label>分类<select disabled={generating} value={draft.category} onChange={event => onUpdate({ category: event.target.value })}>{["待识别", "上衣", "外套", "下装", "连衣裙", "鞋履", "配饰", "帽子"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>季节<select disabled={generating} value={draft.season} onChange={event => onUpdate({ season: event.target.value })}>{["四季", "春秋", "夏季", "冬季"].map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <div className="recognized-tags">
      <span><i style={{ background: draft.colorHex }} />{draft.colorName}</span>
      {garmentTagLabels(draft.aiTags).slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}
      <span>正式 {draft.aiTags.formality}/5</span>
      <span>保暖 {draft.aiTags.warmth}/5</span>
      <span>{qualityLabel}</span>
    </div>
  </article>;
}

export default function Home() {
  return <AuthGate><YidaApp /></AuthGate>;
}

function Thinking({ phase }: { phase: TaskPhase }) {
  const message = phase === "recovering" ? "正在恢复上次的搭配任务" : phase === "submitting" ? "正在安全提交搭配需求" : "正在理解天气、场合和你";
  return <section className="ai-thinking" aria-live="polite"><div className="scan-stage"><span className="scan-ring ring-a" /><span className="scan-ring ring-b" /><div className="scan-clothes">{garments.slice(0, 4).map(item => <GarmentArt key={item.id} color={item.color} mini />)}</div><span className="scan-line" /></div><div className="thinking-copy"><span>AI STYLING IN PROGRESS</span><b>{message}</b><i><em /></i></div></section>;
}

function Results({ scene, scope, recommendations, intent, selectedId, setSelectedId, generateLooks, generateTryOn, modelReady, openModelUpload, tryOnLoading, weather, chatMessages, chatInput, setChatInput, sendChat, chatTyping }: {
  scene: Scene; scope: Scope; recommendations: OutfitRecommendation[]; intent: OutfitIntent | null; selectedId: string | null; setSelectedId: (id: string) => void;
  generateLooks: () => void; generateTryOn: () => void; modelReady: boolean; openModelUpload: () => void; tryOnLoading: boolean; weather: WeatherContext;
  chatMessages: ChatMessage[]; chatInput: string; setChatInput: (value: string) => void; sendChat: () => void; chatTyping: boolean;
}) {
  return <section className="results-section dynamic-results">
    <div className="section-heading"><div><span className="micro-label">TODAY&apos;S EDIT</span><h3>{scene}的三套衣柜方案</h3></div><button onClick={generateLooks}>换一批</button></div>
    <p className="result-context">{scope} · {weather.city} {weather.temperature}° / {weather.condition}{(intent?.styles || intent?.style)?.length ? ` · ${(intent?.styles || intent?.style || []).join("、")}` : ""}{intent?.intensity ? ` · ${intent.intensity}` : ""}</p>
    <div className="outfit-list">{recommendations.map((look, index) => <button type="button" className={`real-outfit-card ${selectedId === look.id ? "active" : ""}`} key={look.id} aria-pressed={selectedId === look.id} onClick={() => setSelectedId(look.id)}>
      <div className="real-look-top"><span>LOOK 0{index + 1}</span><b>{look.score}<small>分</small></b></div>
      <div className="real-outfit-board">{look.items.map(item => <figure key={item.id}><img src={item.imageUrl} alt={item.name} /><figcaption>{item.category}</figcaption></figure>)}</div>
      <div className="real-look-copy"><h4>{look.title}</h4><p>{look.reason}</p><div>{(look.highlights || []).map(tag => <span key={tag}>{tag}</span>)}</div>{look.missingSuggestion && <small>可选添置：{look.missingSuggestion}</small>}</div>
      <span className="real-look-select">{selectedId === look.id ? "✓ 已选择" : "选择这套"}</span>
    </button>)}</div>
    <button className="model-button" disabled={!selectedId} onClick={() => { if (modelReady) generateTryOn(); else openModelUpload(); }}>{!selectedId ? "先选择一套喜欢的穿搭" : tryOnLoading ? "查看搭配速览（高清生成中）" : modelReady ? "用我的全身照生成效果图" : "上传全身照后生成效果图"}</button>
    <section className="chat-assistant"><div className="chat-title"><span><Icon name="spark" /></span><div><b>继续和 LAYRA 聊</b><small>可以持续调整颜色、单品与正式程度</small></div></div><div className="chat-messages">{chatMessages.map((message, index) => <p key={`${message.role}-${index}`} className={message.role}>{message.text}</p>)}{chatTyping && <p className="assistant typing">正在想…</p>}</div><div className="chat-quick">{["换双鞋", "更正式一点", "颜色再克制些"].map(item => <button key={item} onClick={() => setChatInput(item)}>{item}</button>)}</div><div className="chat-input"><input value={chatInput} onChange={event => setChatInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") sendChat(); }} placeholder="例如：用这件外套重新搭一套" /><button onClick={sendChat}>发送</button></div></section>
  </section>;
}
