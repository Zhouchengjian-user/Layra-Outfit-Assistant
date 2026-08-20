"use client";

/* Dynamic R2 and user-uploaded image URLs cannot use a fixed Next Image loader. */
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useRef, useState } from "react";
import { processGarmentUpload, type ProcessedGarmentImage } from "./lib/garment-image";
import { garmentTagLabels, type GarmentAITags } from "./lib/garment-tags";
import { ApiError, createIdempotencyKey, requestJson } from "./lib/api-client";
import {
  buildOutfitReferenceBoard,
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
import { ModalFrame } from "./components/modal-frame";

type Tab = "home" | "wardrobe" | "create" | "inspiration" | "saved" | "profile";
type Scene = "通勤" | "约会" | "休闲" | "聚会" | "运动" | "正式活动";
type Scope = "仅个人衣柜" | "衣柜＋建议添置" | "灵感扩展";
type ChatMessage = { role: "user" | "assistant"; text: string };
type WardrobeItem = {
  id: string; name: string; category: string; colorName: string; colorHex: string;
  season: string; style: string; status: "available" | "washing"; createdAt: number; imageUrl: string; aiTags: GarmentAITags; tagVersion: number;
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
  if (/下装|裤子|裤|裙子|裙/.test(text)) return "下装";
  if (/连衣裙|连体/.test(text)) return "连衣裙";
  if (/帽/.test(text)) return "帽子";
  if (/配饰|包|腰带|首饰|项链|耳环|围巾/.test(text)) return "配饰";
  if (/上衣|内搭|衬衫|T恤|t恤|针织|卫衣|毛衣/.test(text)) return "上衣";
  return null;
}

const scenes: Scene[] = ["通勤", "约会", "休闲", "聚会", "运动", "正式活动"];
const prompts = ["帮我推荐今日穿搭", "今天想穿得松弛又精神", "晚上的约会怎么穿？", "帮我搭一套显比例的通勤装", "明天上班想穿得舒服又有精神", "约会想穿得温柔一点", "通勤但不要太正式", "下雨天也要显比例"];
const suggestions = ["帮我推荐今日穿搭", "今晚约会，想穿得温柔一点", "通勤但不要太正式", "下雨天也要显比例"];
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

const inspirationThemes = [
  { id: 1, title: "清爽学院感", desc: "适合上课与周末看展", colors: ["cream", "denim", "white"] },
  { id: 2, title: "不费力通勤", desc: "利落但没有距离感", colors: ["olive", "charcoal", "caramel"] },
  { id: 3, title: "温柔约会感", desc: "低饱和色更耐看", colors: ["cream", "wine", "white"] },
  { id: 4, title: "轻复古周末", desc: "一点焦糖色就够了", colors: ["denim", "caramel", "black"] },
  { id: 5, title: "运动松弛感", desc: "舒适也可以很有型", colors: ["white", "charcoal", "black"] },
  { id: 6, title: "正式但不老气", desc: "用比例代替堆砌", colors: ["olive", "cream", "charcoal"] },
];

function Icon({ name }: { name: string }) {
  const icons: Record<string, string> = {
    home: "⌂", wardrobe: "▦", create: "+", profile: "♙", gallery: "▧", saved: "♡", help: "?", history: "↺",
    sun: "☼", spark: "✦", camera: "◉", check: "✓", arrow: "→", tune: "⌘", heart: "♡", calendar: "□",
  };
  return <span aria-hidden="true">{icons[name] || "·"}</span>;
}

function GarmentArt({ color, mini = false }: { color: string; mini?: boolean }) {
  return <div className={`garment-art ${color} ${mini ? "mini" : ""}`}><span className="garment-neck" /><span className="garment-body" /><span className="garment-detail" /></div>;
}

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const items: Array<{ id: Tab; name: string; icon: string }> = [
    { id: "home", name: "今日", icon: "home" }, { id: "wardrobe", name: "衣柜", icon: "wardrobe" },
    { id: "create", name: "搭配", icon: "create" }, { id: "inspiration", name: "灵感", icon: "gallery" },
    { id: "saved", name: "收藏", icon: "saved" },
    { id: "profile", name: "我的", icon: "profile" },
  ];
  return <nav className="bottom-nav" aria-label="主导航">{items.map(item => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} /><small>{item.name}</small></button>)}</nav>;
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

export default function Home() {
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
  const [showTryOn, setShowTryOn] = useState(false);
  const [weather, setWeather] = useState<WeatherContext>({ city: "杭州", temperature: 24, apparent: 25, condition: "多云", precipitation: 0, wind: 8, source: "fallback" });
  const [wardrobeItems, setWardrobeItems] = useState<WardrobeItem[]>([]);
  const [wardrobeLoading, setWardrobeLoading] = useState(true);
  const [starterLoading, setStarterLoading] = useState(false);
  const [starterGender, setStarterGender] = useState<"女" | "男" | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [uploadSaving, setUploadSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [garmentDrafts, setGarmentDrafts] = useState<GarmentDraft[]>([]);
  const [editingWardrobe, setEditingWardrobe] = useState<WardrobeItem | null>(null);
  const [closetFilter, setClosetFilter] = useState("全部");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [reviewResult, setReviewResult] = useState<OutfitReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [savedOutfits, setSavedOutfits] = useState<SavedOutfit[]>([]);
  const [saveLoading, setSaveLoading] = useState(false);
  const [tryOnContext, setTryOnContext] = useState<{ itemIds: string[]; title: string; scene: string } | null>(null);
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
  const [profile, setProfile] = useState({ nickname: "阿禾", gender: "女", height: "168", weight: "55", bodyType: "直筒型" });
  const [chatInput, setChatInput] = useState("");
  const [chatTyping, setChatTyping] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([{ role: "assistant", text: "三套都来自你的衣柜。想换颜色、鞋子或调整正式程度，直接告诉我。" }]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const modelFileRef = useRef<HTMLInputElement>(null);
  const uploadModeRef = useRef<"replace" | "append">("replace");
  const uploadBatchRef = useRef(0);
  const uploadJobActiveRef = useRef(false);
  const outfitJobActiveRef = useRef(false);
  const tryOnJobActiveRef = useRef(false);
  const tryOnCacheRef = useRef<Map<string, string>>(new Map());
  const loading = ["submitting", "running", "recovering"].includes(recommendationPhase);
  const tryOnLoading = ["submitting", "running", "recovering"].includes(tryOnPhase);
  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

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
    setTryOnContext({ itemIds: selectedItems, title: "我的自主搭配", scene });
    if (tryOnJobActiveRef.current) { notify("效果图正在生成，请稍等"); return; }
    tryOnJobActiveRef.current = true;
    setTryOnUrl("");
    setShowTryOn(true);
    setTryOnPhase("submitting");
    let taskId = "";
    try {
      const items = selectedItems.map(id => wardrobeItems.find(w => w.id === id)).filter((item): item is WardrobeItem => Boolean(item));
      const outfitBoard = await buildOutfitReferenceBoard(items);
      taskId = createIdempotencyKey();
      const form = new FormData();
      form.append("outfitBoard", outfitBoard, "outfit-reference.jpg");
      form.append("itemIds", JSON.stringify(selectedItems));
      form.append("title", "我的自主搭配");
      form.append("scene", scene);
      form.append("prompt", prompt);
      setTryOnPhase("running");
      const resultUrl = URL.createObjectURL(await submitVisualizationTask(taskId, form));
      tryOnCacheRef.current.set(`create-${selectedItems.join("|")}`, resultUrl);
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
    const matches = wardrobeItems.filter(item => item.status === "available" && families.some(family => item.colorName.includes(family) || item.aiTags.colorFamily === family));
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
    setRecommendations(payload.recommendations);
    setOutfitIntent(payload.intent || null);
    setSelectedRecommendationId(null);
    setShowResults(true);
    window.setTimeout(() => document.querySelector(".results-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }, []);

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
    if (!taskId || !lookId || !recommendations.some(item => item.id === lookId)) return;
    const cachedUrl = tryOnCacheRef.current.get(lookId);
    if (cachedUrl) return;
    const controller = new AbortController();
    tryOnJobActiveRef.current = true;
    const phaseTimer = window.setTimeout(() => {
      if (controller.signal.aborted) return;
      setSelectedRecommendationId(lookId);
      setShowTryOn(true);
      setTryOnPhase("recovering");
    }, 0);
    pollVisualizationTask(taskId, controller.signal)
      .then(blob => {
        const resultUrl = URL.createObjectURL(blob);
        tryOnCacheRef.current.set(lookId, resultUrl);
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
  }, [notify, ownerReady, recommendations]);

  const openUploadPicker = (mode: "replace" | "append" = "replace") => {
    if (uploadJobActiveRef.current) {
      notify("当前照片还在处理中，请完成后再继续添加");
      return;
    }
    uploadModeRef.current = mode;
    fileRef.current?.click();
  };

  const generateLooks = async () => {
    if (outfitJobActiveRef.current) { notify("正在生成这一组搭配，请稍等"); return; }
    if (generationsLeft <= 0) { notify("今天的生成次数已用完，明天 00:00 恢复"); return; }
    if (wardrobeItems.filter(item => item.status === "available").length < 2) { notify("衣柜里至少需要 2 件可穿单品，先添加衣服吧"); setTab("wardrobe"); return; }
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

  const generateTryOn = async (recommendationOverride?: OutfitRecommendation) => {
    const recommendation = recommendationOverride || recommendations.find(item => item.id === selectedRecommendationId);
    if (!recommendation) { notify("请先选择一套搭配"); return; }
    if (!modelProfile) { modelFileRef.current?.click(); return; }
    setTryOnContext({ itemIds: recommendation.itemIds, title: recommendation.title, scene });
    const cachedUrl = tryOnCacheRef.current.get(recommendation.id);
    if (cachedUrl) {
      setTryOnUrl(cachedUrl);
      setShowTryOn(true);
      setTryOnPhase("succeeded");
      return;
    }
    if (tryOnJobActiveRef.current) { notify("这张效果图正在生成，请稍等"); return; }
    tryOnJobActiveRef.current = true;
    setTryOnUrl("");
    setShowTryOn(true);
    setTryOnPhase("submitting");
    let taskId = "";
    try {
      const outfitBoard = await buildOutfitReferenceBoard(recommendation.items);
      taskId = createIdempotencyKey();
      window.sessionStorage.setItem(lastVisualizationTaskKey, taskId);
      window.sessionStorage.setItem(lastVisualizationLookKey, recommendation.id);
      const form = new FormData();
      form.append("outfitBoard", outfitBoard, "outfit-reference.jpg");
      form.append("itemIds", JSON.stringify(recommendation.itemIds));
      form.append("title", recommendation.title);
      form.append("scene", scene);
      form.append("prompt", prompt);
      setTryOnPhase("running");
      const resultUrl = URL.createObjectURL(await submitVisualizationTask(taskId, form));
      tryOnCacheRef.current.set(recommendation.id, resultUrl);
      setTryOnUrl(resultUrl);
      setTryOnPhase("succeeded");
    } catch (error) {
      if (taskId) {
        window.sessionStorage.removeItem(lastVisualizationTaskKey);
        window.sessionStorage.removeItem(lastVisualizationLookKey);
      }
      setTryOnPhase("failed");
      setShowTryOn(false);
      notify(error instanceof Error ? error.message : "效果图生成失败");
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
    uploadJobActiveRef.current = true;
    const mode = uploadModeRef.current;
    uploadModeRef.current = "replace";
    const batchId = ++uploadBatchRef.current;
    setTab("wardrobe");
    setUploadOpen(true);
    setUploadProcessing(true);
    setUploadProgress(0);
    setUploadTotal(selected.length);
    if (mode === "replace") {
      setGarmentDrafts(current => {
        current.forEach(item => { URL.revokeObjectURL(item.previewUrl); URL.revokeObjectURL(item.originalUrl); });
        return [];
      });
    }
    try {
      for (let index = 0; index < selected.length; index++) {
        const processedItems = await processGarmentUpload(selected[index]);
        if (uploadBatchRef.current !== batchId) {
          processedItems.forEach(item => { URL.revokeObjectURL(item.previewUrl); URL.revokeObjectURL(item.originalUrl); });
          return;
        }
        setGarmentDrafts(current => [...current, ...processedItems.map(processed => ({ ...processed, id: crypto.randomUUID(), selected: processed.cutoutQuality === "good" }))]);
        setUploadProgress(index + 1);
      }
    } catch {
      if (uploadBatchRef.current === batchId) notify("有一张图片处理失败，请换一张清晰照片再试");
    } finally {
      uploadJobActiveRef.current = false;
      if (uploadBatchRef.current === batchId) setUploadProcessing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const updateGarmentDraft = (id: string, patch: Partial<GarmentDraft>) => {
    setGarmentDrafts(current => current.map(item => item.id === id ? { ...item, ...patch } : item));
  };

  const closeUpload = () => {
    uploadBatchRef.current += 1;
    garmentDrafts.forEach(item => { URL.revokeObjectURL(item.previewUrl); URL.revokeObjectURL(item.originalUrl); });
    setGarmentDrafts([]);
    setUploadProcessing(false);
    setUploadOpen(false);
  };

  const saveGarmentDrafts = async () => {
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
    if (wardrobeItems.length >= 8) {
      notify("衣柜里已经有衣服了，可以直接开始推荐");
      return;
    }
    const targetGender = genderOverride || (profile.gender === "男" ? "男" : "女");
    setStarterGender(targetGender);
    setStarterLoading(true);
    notify(targetGender === "男" ? "正在为你生成男生基础衣柜…" : "正在为你生成女生基础衣柜…");
    try {
      const { data: payload } = await requestJson<{ saved: number; reused?: boolean; items?: Array<{ id: string; name: string; category: string; colorName: string; colorHex: string; season: string; style: string }> }>("/api/wardrobe/starter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gender: targetGender }),
        timeoutMs: 240_000,
      });
      if (payload.reused) {
        notify("你的预设衣柜已经准备好了，可以直接开始推荐");
      } else if (payload.saved) {
        notify(`已放入 ${payload.saved} 件${targetGender === "男" ? "男生" : "女生"}基础单品，上传全身照就能开始体验`);
      }
      if (payload.items?.length) {
        const mapped: WardrobeItem[] = payload.items.map(item => ({
          ...item,
          status: "available" as const,
          createdAt: Date.now(),
          imageUrl: `/api/wardrobe?image=${item.id}`,
          aiTags: { version: 2 as const, subcategory: item.category, material: "", pattern: "", fit: "", length: "", colorTone: "", colorFamily: item.colorName, colorTemperature: "", lightness: "", saturation: "", layer: "", silhouette: "", visualWeight: "", waistline: "", rise: "", legShape: "", patternScale: "", statementLevel: 1, role: "", layering: [], warmth: 3, formality: 3, styles: [], occasions: [], seasons: [], weather: [] },
          tagVersion: 2,
        }));
        setWardrobeItems(current => [...mapped, ...current]);
      }
      setTab("home");
    } catch (error) {
      notify(error instanceof Error ? error.message : "预设衣柜暂时没有准备好，请稍后重试");
    } finally {
      setStarterLoading(false);
    }
  };

  const openStarterPicker = () => {
    if (starterLoading) return;
    // 始终先让用户明确选择性别，避免默认值猜错
    setShowStarterPicker(true);
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

  const handleSwapRequest = (text: string) => {
    setChatTyping(true);
    const category = parseSwapCategory(text);
    if (!category) {
      const handled = handleStyleAdjustment(text);
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
    if (!selectedRecommendationId) {
      setChatMessages(current => [...current, { role: "assistant", text: "请先在推荐结果里选择一套搭配，再说要换哪件。" }]);
      setChatTyping(false);
      return;
    }
    setSwapCategory(category);
    setShowSwapModal(true);
    window.setTimeout(() => setChatTyping(false), 500);
  };

  const handleStyleAdjustment = (text: string): boolean => {
    const recommendation = recommendations.find(item => item.id === selectedRecommendationId);
    if (!recommendation) return false;
    const wardrobeLookup = new Map(wardrobeItems.map(item => [item.id, item]));
    const outfitItems = recommendation.items.map(item => wardrobeLookup.get(item.id)).filter((item): item is WardrobeItem => Boolean(item));
    if (!outfitItems.length) return false;
    let replaced = false;
    if (/更正式|正式一点|商务/.test(text)) {
      const candidates = outfitItems.map(current => {
        const alternatives = wardrobeItems.filter(item => item.status === "available" && item.category === current.category && item.id !== current.id && item.aiTags.formality > current.aiTags.formality).sort((a, b) => b.aiTags.formality - a.aiTags.formality);
        return { current, next: alternatives[0] };
      }).filter(entry => entry.next);
      const best = candidates.sort((a, b) => b.next.aiTags.formality - a.next.aiTags.formality)[0];
      if (best) { applyItemSwap(best.current.category, best.next); replaced = true; }
    } else if (/休闲一点|更休闲|随意/.test(text)) {
      const candidates = outfitItems.map(current => {
        const alternatives = wardrobeItems.filter(item => item.status === "available" && item.category === current.category && item.id !== current.id && item.aiTags.formality < current.aiTags.formality).sort((a, b) => a.aiTags.formality - b.aiTags.formality);
        return { current, next: alternatives[0] };
      }).filter(entry => entry.next);
      const best = candidates.sort((a, b) => a.next.aiTags.formality - b.next.aiTags.formality)[0];
      if (best) { applyItemSwap(best.current.category, best.next); replaced = true; }
    } else if (/颜色再克制|颜色克制|更低调|更素/.test(text)) {
      const neutralFamilies = ["黑色", "白色", "灰色", "米色", "棕色"];
      const candidates = outfitItems.map(current => {
        const alternatives = wardrobeItems.filter(item => item.status === "available" && item.category === current.category && item.id !== current.id && neutralFamilies.includes(item.aiTags.colorFamily));
        return { current, next: alternatives[0] };
      }).filter(entry => entry.next);
      const colorful = candidates.filter(entry => !neutralFamilies.includes(entry.current.aiTags.colorFamily));
      const best = (colorful.length ? colorful : candidates).sort((a, b) => (b.current.aiTags.statementLevel || 2) - (a.current.aiTags.statementLevel || 2))[0];
      if (best) { applyItemSwap(best.current.category, best.next); replaced = true; }
    }
    return replaced;
  };

  const applyItemSwap = (category: string, newItem: WardrobeItem) => {
    const mapped = { id: newItem.id, name: newItem.name, category: newItem.category, colorName: newItem.colorName, season: newItem.season, style: newItem.style, imageUrl: newItem.imageUrl };
    setRecommendations(current => current.map(rec => {
      if (rec.id !== selectedRecommendationId) return rec;
      const items = [...rec.items];
      const index = items.findIndex(item => item.category === category);
      if (index >= 0) items[index] = mapped;
      else items.push(mapped);
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
    handleSwapRequest(value);
  };

  const swapItem = (itemId: string) => {
    const newItem = wardrobeItems.find(item => item.id === itemId);
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

  const filters = ["全部", "清洗中", "上衣", "外套", "下装", "鞋履", "配饰", "帽子"];
  const filteredWardrobe = closetFilter === "全部" ? wardrobeItems : closetFilter === "清洗中" ? wardrobeItems.filter(item => item.status === "washing") : wardrobeItems.filter(item => item.category === closetFilter);
  const cycleScope = () => notify("当前阶段的三套推荐只使用个人衣柜");

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
    <div className="screen home-screen mobile-home">
      <header className="app-header"><div className="mobile-brand"><img src="/yida-logo.png" alt="易搭" /><div><span className="micro-label">易搭 · THURSDAY, 13 AUG</span><h2>早上好，{profile.nickname}</h2></div></div><button className="avatar" onClick={() => setTab("profile")}>{profile.nickname.slice(0, 1)}</button></header>
      <button className="weather-strip" onClick={() => setShowWeather(true)}><div className="weather-icon"><Icon name="sun" /></div><div><b>{city} {weather.temperature}° / {weather.condition}</b><span>天气已同步 · 体感 {weather.apparent}°</span></div><small>穿薄层 ›</small></button>
      <ModelProfileStrip profile={modelProfile} uploading={modelUploading} onUpload={() => modelFileRef.current?.click()} />
      {!wardrobeItems.length && !starterLoading && <button className="starter-cta-mobile" onClick={openStarterPicker}><span>⚡</span><div><b>不想上传衣服？先用预设衣柜体验</b><small>{starterGender === "男" ? "男生基础单品已配好，只差你的全身照" : "女生基础单品已配好，只差你的全身照"}</small></div><i>→</i></button>}
      {starterLoading && <section className="starter-progress-mobile"><span className="spinner" /> 正在准备预设衣柜…</section>}
      <section className="prompt-card">
        <div className="prompt-head"><span><Icon name="spark" /> AI 穿搭灵感</span><b>剩余 {generationsLeft} / 5 次</b></div>
        <div className="scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
        <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="输入穿搭需求" />
        <div className="mobile-composer-foot"><button className="mobile-mode-select" onClick={cycleScope}>{scope}⌄</button><button className="generate-button" onClick={generateLooks} disabled={loading}>{loading ? <><span className="spinner" />搭配中...</> : <>生成三套 <Icon name="arrow" /></>}</button></div>
      </section>
      {!wardrobeItems.length && <button className="quick-start-mobile" onClick={() => setTab("wardrobe")}><span>✦</span><div><b>先把常穿单品放进衣柜</b><small>所有推荐都会严格使用你的真实衣物</small></div><i>→</i></button>}
      {!showResults && !loading && <section className="closet-glance"><div className="section-heading"><div><span className="micro-label">MY CLOSET</span><h3>{wardrobeItems.length ? `衣柜里有 ${wardrobeItems.length} 件衣服` : "从第一件衣服开始建立衣柜"}</h3></div><button onClick={() => setTab("wardrobe")}>{wardrobeItems.length ? "去看看" : "立即上传"} →</button></div>{wardrobeItems.length ? <div className="glance-grid real-glance">{wardrobeItems.slice(0, 4).map(item => <div key={item.id}><img src={item.imageUrl} alt={item.name} /><span>{item.category}</span></div>)}</div> : <div className="closet-empty-glance"><span>＋</span><p>拍一张衣物照片，易搭会自动抠图和整理标签</p></div>}</section>}
      {loading && <Thinking phase={recommendationPhase} />}
      <div className="results-anchor" />
      {showResults && resultsBlock}
    </div>
  );

  return (
    <main className={`site-shell ${loading ? "is-thinking" : ""}`}>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={event => handleUpload(event.target.files)} />
      <input ref={modelFileRef} type="file" accept="image/*" hidden onChange={event => handleModelUpload(event.target.files)} />

      <aside className="desktop-sidebar">
        <div className="side-brand"><button className="side-logo" onClick={() => setTab("home")} aria-label="易搭首页"><img src="/yida-logo.png" alt="易搭" /></button><strong>易搭</strong><button className="collapse-side" onClick={() => notify("移动端将自动收起侧栏")}>‹</button></div>
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
        <div className="sidebar-bottom"><button onClick={() => notify("有问题？告诉易搭就好")}><Icon name="help" /><span>帮助与反馈</span></button><button className="side-profile" onClick={() => setTab("profile")}><span className="side-avatar">{profile.nickname.slice(0, 1)}</span><b>{profile.nickname}</b><small>{generationsLeft} 次生成额度</small></button></div>
      </aside>

      <header className="desktop-topbar">
        <div className="topbar-title"><span>{tab === "home" ? "新对话" : tab === "wardrobe" ? "我的衣柜" : tab === "create" ? "个人搭配" : tab === "inspiration" ? "灵感画廊" : "个人中心"}</span></div>
        <div className="topbar-meta"><button className="weather-pill" onClick={() => setShowWeather(true)}>☁ {weather.temperature}° {city}</button><button className="points-pill" onClick={() => setTab("profile")}>今日剩余 {generationsLeft} 次</button><button className="side-avatar" onClick={() => setTab("profile")}>{profile.nickname.slice(0, 1)}</button></div>
      </header>

      <section className="studio-surface">
        {tab === "home" && <><div className="desktop-home chat-home">
          <div className="hero-copy"><span className="mode-pill">易搭 AI 穿搭助手</span><h1>今天想怎么穿？</h1><p>选择场景，再告诉易搭你的需求。它会从衣柜里挑出三套搭配。</p></div>
          <div className="desktop-scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
          <div className="suggestion-row chat-suggestions">{suggestions.slice(0, 3).map((item, index) => <button key={item} onClick={() => setPrompt(item)}><b>{["舒服又精神", "约会温柔一点", "通勤不太正式"][index]}</b><small>{["今日推荐", "晚餐或看展", "办公室"][index]}</small></button>)}</div>
          <ModelProfileStrip profile={modelProfile} uploading={modelUploading} onUpload={() => modelFileRef.current?.click()} />
          <section className="studio-composer chat-composer"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="描述今天想要的穿搭" /><div className="composer-actions"><div className="composer-left"><button className="add-round" onClick={() => openUploadPicker("replace")}>＋</button><button className="single-scope" onClick={cycleScope}>{scope}<span>⌄</span></button></div><button className="primary-generate" onClick={generateLooks} disabled={loading}>{loading ? "正在搭配…" : "生成 3 套搭配"}<span>→</span></button></div></section>
          {loading && <Thinking phase={recommendationPhase} />}
          <div className="results-anchor" />
          {showResults ? resultsBlock : <><section className="quick-start-panel"><div><span>开始推荐前</span><h3>{wardrobeItems.length ? `已从衣柜同步 ${wardrobeItems.length} 件单品` : "先添加你的真实衣物"}</h3><p>{wardrobeItems.length ? "易搭只会从这些单品里给你三个答案，不会偷偷加入陌生衣服。" : "上传、抠图并确认入柜后，才能生成真正属于你的搭配。"}</p></div><div className="quick-start-actions"><button onClick={() => setTab("wardrobe")}>{wardrobeItems.length ? "检查衣柜" : "去添加衣物"} →</button>{!wardrobeItems.length && <button className="starter-cta-desktop" onClick={openStarterPicker} disabled={starterLoading}>{starterLoading ? "正在准备…" : "⚡ 先用预设衣柜"}</button>}</div></section><ShortcutSection setTab={setTab} /></>}
        </div>{mobileHome}</>}

        {tab === "wardrobe" && <div className="screen wardrobe-screen">
          <header className="sub-header"><div><span className="micro-label">MY CLOSET</span><h2>我的衣柜 <sup>{wardrobeItems.length}</sup></h2><p>把真实衣服整理好，之后的搭配才会真正属于你。</p></div><button className="round-add" onClick={() => openUploadPicker("replace")} aria-label="上传衣物">+</button></header>
          <div className="closet-status"><span><b>{wardrobeItems.filter(item => item.status === "available").length}</b> 件可穿</span><span><b>{wardrobeItems.filter(item => item.status === "washing").length}</b> 件清洗中</span><span><b>{new Set(wardrobeItems.flatMap(item => garmentTagLabels(item.aiTags))).size}</b> 个AI搭配标签</span></div>
          <button className="upload-zone" onClick={() => openUploadPicker("replace")}><span className="upload-icon"><Icon name="camera" /></span><span><b>拍照或从相册上传衣物</b><small>自动逐件识别、抠图与整理标签，确认后加入衣柜</small><em>一张图可包含多件单品 · 单次最多 5 张</em></span><strong>开始上传 →</strong></button>
          <div className="wardrobe-toolbar"><div className="filter-row">{filters.map(filter => <button key={filter} className={closetFilter === filter ? "active" : ""} onClick={() => setClosetFilter(filter)}>{filter}</button>)}</div><span>{closetFilter === "全部" ? "全部单品" : closetFilter} · {filteredWardrobe.length}</span></div>
          {wardrobeLoading ? <div className="wardrobe-loading"><span className="spinner" /> 正在同步衣柜…</div> : filteredWardrobe.length ? <div className="wardrobe-grid saved-wardrobe-grid">
            {filteredWardrobe.map(item => <article className={`wardrobe-item saved-garment ${item.status === "washing" ? "is-washing" : ""}`} key={item.id}><div className="uploaded-wrap product-white"><img src={item.imageUrl} alt={item.name} loading="lazy" /><span className="ai-tag">{item.status === "washing" ? "清洗中" : "已入柜"}</span><i className="garment-color-dot" style={{ background: item.colorHex }} /></div><b>{item.name}</b><small>{item.colorName} · {item.category} · {item.season}</small><div className="wardrobe-ai-tags">{garmentTagLabels(item.aiTags).slice(0, 5).map(tag => <span key={tag}>{tag}</span>)}<span>正式 {item.aiTags.formality}/5</span><span>保暖 {item.aiTags.warmth}/5</span></div><div className="wardrobe-actions"><button onClick={() => setEditingWardrobe(item)}>编辑</button><button onClick={() => updateWardrobeItem(item.id, { status: item.status === "washing" ? "available" : "washing" })}>{item.status === "washing" ? "恢复可穿" : "标记清洗"}</button><button onClick={() => deleteWardrobeItem(item)}>删除</button></div></article>)}
          </div> : <section className="wardrobe-empty"><div><span>＋</span></div><h3>{closetFilter === "全部" ? "衣柜还是空的" : closetFilter === "清洗中" ? "没有清洗中的衣服" : `还没有${closetFilter}`}</h3><p>{closetFilter === "全部" ? "先上传一件常穿的衣服。易搭会自动抠掉背景、识别标签，你只需要确认一下。" : closetFilter === "清洗中" ? "点衣服卡片上的「标记清洗」，它就会出现在这里。" : "可以切换到全部，或上传一件新的单品。"}</p><div className="wardrobe-empty-actions"><button onClick={() => openUploadPicker("replace")}>上传第一件衣服</button>{closetFilter === "全部" && <button className="starter-cta-desktop" onClick={openStarterPicker} disabled={starterLoading}>{starterLoading ? "正在准备…" : "⚡ 先用预设衣柜"}</button>}</div></section>}
          <section className="photo-guide"><span className="micro-label">拍得好，抠得更干净</span><div><p><b>01</b> 衣服平铺或挂直</p><p><b>02</b> 背景干净、颜色有反差</p><p><b>03</b> 光线均匀，避免明显阴影</p></div></section>
        </div>}

        {tab === "create" && <div className="screen create-screen">
          <header className="sub-header"><div><span className="micro-label">STYLE IT YOURSELF</span><h2>今天你来搭</h2></div><span className="step-chip">已选 {selectedItems.length} 件</span></header><p className="lead-copy">从你的衣柜挑出想穿的，AI 会从颜色、版型、天气与场合四个方面点评。</p>
          <section className="canvas-card"><div className="canvas-label"><span>你的搭配</span><button onClick={() => { setSelectedItems([]); setReviewResult(null); }}>清空</button></div><div className="canvas-items">{selectedItems.length ? selectedItems.map(id => { const item = wardrobeItems.find(w => w.id === id); if (!item) return null; return <button key={id} onClick={() => setSelectedItems(items => items.filter(value => value !== id))}><img src={item.imageUrl} alt={item.name} /><span className="remove-chip">×</span></button>; }) : <p>从下面点选单品，把它放进搭配</p>}</div></section>
          <div className="mini-section-title"><b>从衣柜选择</b><span>{wardrobeItems.length} 件</span></div><div className="pick-grid">{wardrobeItems.length ? wardrobeItems.map(item => { const active = selectedItems.includes(item.id); return <button key={item.id} className={active ? "active" : ""} onClick={() => setSelectedItems(items => active ? items.filter(id => id !== item.id) : [...items, item.id])}><img src={item.imageUrl} alt={item.name} loading="lazy" /><small>{item.category} · {item.name}</small>{active && <span className="pick-check"><Icon name="check" /></span>}</button>; }) : <p className="empty-hint">衣柜还是空的，先去「我的衣柜」上传衣服吧</p>}</div>
          <button className="review-button" disabled={selectedItems.length < 2 || reviewLoading} onClick={reviewOutfit}><Icon name="spark" /> {reviewLoading ? "点评中…" : "让 AI 看看这套"}</button>
          {reviewResult && <section className="review-panel"><div className="review-head"><span className="review-score">{reviewResult.score}<small> 分</small></span><span className="micro-label">AI OUTFIT REVIEW</span></div><div className="review-notes"><div><b>颜色协调</b><span>{reviewResult.breakdown.color}</span></div><div><b>版型比例</b><span>{reviewResult.breakdown.silhouette}</span></div><div><b>场合适配</b><span>{reviewResult.breakdown.occasion}</span></div><div><b>天气适配</b><span>{reviewResult.breakdown.weather}</span></div></div><p className="review-suggestion">{reviewResult.suggestion}</p><button className="review-button" onClick={generateTryOnForCreate} disabled={tryOnLoading}>{tryOnLoading ? "正在生成效果图…" : "生成 AI 试穿效果图"}</button></section>}
        </div>}

        {tab === "inspiration" && <div className="screen inspiration-screen"><header className="sub-header"><div><span className="micro-label">DISCOVER YOUR STYLE</span><h2>穿搭灵感</h2></div><span className="step-chip">为你精选</span></header><p className="lead-copy">喜欢或不感兴趣都会帮助易搭更懂你。收藏后可以直接用自己的衣柜复刻。</p><div className="inspiration-grid">{inspirationThemes.map(theme => <article className="inspiration-card" key={theme.id}><button className="inspiration-visual" onClick={() => { setPrompt(`用我的衣柜复刻${theme.title}`); setTab("home"); }}>{theme.colors.map(color => <GarmentArt key={color} color={color} />)}<span>用我的衣柜复刻 →</span></button><h3>{theme.title}</h3><p>{theme.desc}</p><div><button onClick={() => likeTheme(theme.title)}>♡ 喜欢</button><button onClick={() => notify("已减少类似灵感")}>不感兴趣</button><button onClick={() => saveThemeAsOutfit(theme)}>收藏</button></div></article>)}</div></div>}

        {tab === "saved" && <div className="screen saved-screen">
          <header className="sub-header"><div><span className="micro-label">SAVED LOOKS</span><h2>我的收藏</h2></div><span className="step-chip">{savedOutfits.length} 套</span></header><p className="lead-copy">你收藏的搭配都在这里，可以随时查看、删除或再次试穿。</p>
          {savedOutfits.length ? <div className="saved-list">{savedOutfits.map(outfit => <article className="saved-card" key={outfit.id}><div className="saved-card-items">{outfit.items.map(item => <img key={item.id} src={item.imageUrl} alt={item.name} />)}</div><div className="saved-card-meta"><b>{outfit.title}</b><small>{outfit.scene} · {outfit.items.length} 件 · {formatHistoryDate(outfit.createdAt)}</small></div><div className="saved-card-actions"><button className="saved-card-tryon" onClick={() => retrySavedOutfit(outfit)}>再次试穿</button><button className="saved-card-del" onClick={() => deleteSavedOutfit(outfit.id)}>删除</button></div></article>)}</div> : <section className="wardrobe-empty"><div><span>♡</span></div><h3>还没有收藏的搭配</h3><p>生成试穿效果图后，点「☆ 收藏这套搭配」就会出现在这里。</p><button onClick={() => setTab("home")}>去生成一套 →</button></section>}
        </div>}

        {tab === "profile" && <div className="screen profile-screen">
          <header className="sub-header"><div><span className="micro-label">PROFILE</span><h2>关于{profile.nickname}</h2></div><button className="edit-link" onClick={() => setShowProfileEdit(true)}>编辑资料</button></header>
          <section className="profile-hero"><div className="big-avatar">{profile.nickname.slice(0, 1)}</div><div><h3>{profile.nickname}</h3><p>穿衣要舒服，也要有一点意思。· {city}</p></div></section>
          <ModelProfileStrip profile={modelProfile} uploading={modelUploading} onUpload={() => modelFileRef.current?.click()} />
          <section className="body-card"><div><span>性别</span><b>{profile.gender}</b></div><div><span>身高</span><b>{profile.height}<small> cm</small></b></div><div><span>体重</span><b>{profile.weight}<small> kg</small></b></div><div><span>身材比例</span><b>{profile.bodyType}</b></div></section>
          <section className="taste-card"><span className="micro-label">STYLE DNA</span><h3>你的风格偏好</h3><p className="taste-help">点选喜欢的风格，随时可以调整</p><div className="preference-chips">{styleOptions.map(item => <button key={item} className={stylePrefs.includes(item) ? "active" : ""} onClick={() => toggleStyle(item)}>{stylePrefs.includes(item) ? "✓ " : "+ "}{item}</button>)}</div></section>
          <div className="profile-feature-grid"><section className="usage-card"><div><span>今日生成额度</span><b>{generationsLeft} / 5</b></div><div className="usage-track"><i style={{ width: `${generationsLeft * 20}%` }} /></div><small>每日 00:00 自动恢复</small></section><section className="points-card"><span>易搭积分</span><b>260</b><small>上传衣服和完善衣柜可获得积分</small><button onClick={() => notify("积分商城将在后续版本开放")}>查看权益 →</button></section></div>
          <section className="profile-section"><div className="section-heading"><div><span className="micro-label">HISTORY · 30 DAYS</span><h3>最近记录</h3></div><Icon name="history" /></div><div className="history-list">{history.map(item => <button key={item.id} onClick={() => replayHistory(item)}><span>{formatHistoryDate(item.createdAt)}</span><b>{item.scene}</b><p>{item.prompt}</p><i>›</i></button>)}</div></section>
          <div className="settings-list"><button onClick={() => setShowWeather(true)}>常驻城市 <span>{city} ›</span></button><button onClick={() => notify("手机号登录将在正式版开放")}>手机号与微信 <span>未绑定 ›</span></button><button onClick={() => notify("照片仅用于生成你的专属效果图")}>照片与隐私 <span>已授权 ›</span></button></div>
        </div>}
      </section>

      <BottomNav tab={tab} setTab={setTab} />

      {showSwapModal && <ModalFrame onClose={() => setShowSwapModal(false)} panelClassName="compact-modal"><button className="modal-close" onClick={() => setShowSwapModal(false)}>×</button><span className="micro-label">从衣柜选择替换单品</span><h3>换一件{swapCategory}</h3><div className="swap-grid">{wardrobeItems.filter(item => item.category === swapCategory).map(item => <button key={item.id} onClick={() => swapItem(item.id)}><img src={item.imageUrl} alt={item.name} /><small>{item.name}</small></button>)}{!wardrobeItems.some(item => item.category === swapCategory) && <p className="empty-hint">衣柜里暂时没有{swapCategory}，先去「我的衣柜」上传吧</p>}</div></ModalFrame>}
      {showStarterPicker && <ModalFrame onClose={() => setShowStarterPicker(false)} panelClassName="compact-modal"><button className="modal-close" onClick={() => setShowStarterPicker(false)}>×</button><span className="micro-label">STARTER CLOSET</span><h3>选一套预设衣柜</h3><p>我们为女生和男生各准备了一套 12 件基础单品，选择后会直接放进你的衣柜，之后随时可以换成自己的衣服。</p><div className="starter-gender-grid"><button onClick={() => { setProfile(value => ({ ...value, gender: "女" })); saveProfile({ ...profile, gender: "女" }, stylePrefs); setShowStarterPicker(false); activateStarterWardrobe("女"); }}><b>女生衣柜</b><small>针织衫 · 连衣裙 · 玛丽珍鞋…</small></button><button onClick={() => { setProfile(value => ({ ...value, gender: "男" })); saveProfile({ ...profile, gender: "男" }, stylePrefs); setShowStarterPicker(false); activateStarterWardrobe("男"); }}><b>男生衣柜</b><small>T恤 · 西装 · 德比鞋…</small></button></div></ModalFrame>}
      {showTryOn && <ModalFrame onClose={() => setShowTryOn(false)} closeDisabled={tryOnLoading} panelClassName="personal-tryon-modal"><button className="modal-close" disabled={tryOnLoading} onClick={() => setShowTryOn(false)}>×</button>{tryOnLoading ? <div className="tryon-progress"><div className="tryon-person"><span /><i /></div><span className="micro-label">PERSONAL LOOK GENERATION</span><h3>{tryOnPhase === "recovering" ? "正在恢复上次的效果图" : "正在把这套衣服穿到你身上"}</h3><p>{tryOnPhase === "recovering" ? "无需重新生成，易搭正在读取上次已经提交的结果。" : "易搭正在对齐你的脸部、身材比例和衣柜单品，通常需要几十秒。"}</p><div className="tryon-progress-line"><i /></div></div> : <><div className="personal-tryon-image"><img src={tryOnUrl} alt="我的AI穿搭完整效果图" /></div><div className="personal-tryon-copy"><span className="micro-label">YOUR OUTFIT PREVIEW</span><h3>{recommendations.find(item => item.id === selectedRecommendationId)?.title || "你的今日穿搭"}</h3><p>{recommendations.find(item => item.id === selectedRecommendationId)?.reason}</p><div className="tryon-chat"><input value={tryOnChatInput} onChange={event => setTryOnChatInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") sendTryOnChat(); }} placeholder="边看边说：换鞋 / 换外套…" /><button onClick={sendTryOnChat}>发送</button></div><div className="tryon-actions"><button className="save-btn" onClick={saveCurrentOutfit} disabled={saveLoading}>{saveLoading ? "保存中…" : "☆ 收藏这套搭配"}</button><button onClick={() => setShowTryOn(false)}>完成</button></div></div></>}</ModalFrame>}


      {uploadOpen && <ModalFrame onClose={closeUpload} closeDisabled={uploadProcessing || uploadSaving} panelClassName="upload-modal" backdropClassName="upload-backdrop"><button className="modal-close" disabled={uploadProcessing || uploadSaving} onClick={closeUpload}>×</button><header className="upload-modal-head"><span className="micro-label">SMART WARDROBE IMPORT</span><h3>{uploadProcessing ? "易搭正在生成高清商品图" : "确认后加入衣柜"}</h3><p>{uploadProcessing ? `正在识别、去除人物并生成高清白底图 ${uploadProgress} / ${Math.max(uploadTotal, 1)} 张` : `已整理 ${garmentDrafts.length} 件单品；点击整张卡片即可切换是否加入衣柜`}</p></header>
        {uploadProcessing && <div className="cutout-progress"><div className="cutout-animation"><span /><i /><b>单品处理中</b></div><p>原图仅用于识别与抠图，只有你确认的白底单品图会加入衣柜。</p></div>}
        {!!garmentDrafts.length && <div className="draft-grid">{garmentDrafts.map(draft => <article className={`garment-draft ${draft.selected ? "selected" : ""} quality-${draft.cutoutQuality}`} key={draft.id}><button type="button" className="draft-select-toggle" disabled={draft.cutoutQuality === "failed"} aria-pressed={draft.selected} aria-label={`${draft.name}，${draft.selected ? "取消加入衣柜" : "选择加入衣柜"}`} onClick={() => updateGarmentDraft(draft.id, { selected: !draft.selected })}><span className="draft-state">{draft.cutoutQuality === "failed" ? "生成失败" : draft.selected ? "✓ 已选择" : "点击选择"}</span><div className="draft-preview product-white"><img src={draft.previewUrl} alt={draft.name} />{draft.cutoutQuality === "review" && <span>原图信息不足，请谨慎确认</span>}{draft.cutoutQuality === "failed" && <span>这是原图裁剪，不会入柜</span>}</div></button><label>衣物名称<input value={draft.name} onChange={event => updateGarmentDraft(draft.id, { name: event.target.value })} /></label><div className="draft-fields"><label>分类<select value={draft.category} onChange={event => updateGarmentDraft(draft.id, { category: event.target.value })}>{["上衣", "外套", "下装", "连衣裙", "鞋履", "配饰", "帽子"].map(value => <option key={value}>{value}</option>)}</select></label><label>季节<select value={draft.season} onChange={event => updateGarmentDraft(draft.id, { season: event.target.value })}>{["四季", "春秋", "夏季", "冬季"].map(value => <option key={value}>{value}</option>)}</select></label></div><div className="recognized-tags"><span><i style={{ background: draft.colorHex }} />{draft.colorName}</span>{garmentTagLabels(draft.aiTags).slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}<span>正式 {draft.aiTags.formality}/5</span><span>保暖 {draft.aiTags.warmth}/5</span><span>{draft.cutoutQuality === "good" ? "高清商品图" : draft.cutoutQuality === "review" ? "待人工确认" : "未生成商品图"}</span></div></article>)}</div>}
        {!uploadProcessing && <footer className="upload-modal-foot"><button className="secondary-upload" onClick={() => openUploadPicker("append")}>＋ 继续添加</button><button className="primary-upload" disabled={uploadSaving || !garmentDrafts.some(item => item.selected)} onClick={saveGarmentDrafts}>{uploadSaving ? "正在加入衣柜…" : `加入衣柜（${garmentDrafts.filter(item => item.selected).length}）`}</button></footer>}
      </ModalFrame>}

      {editingWardrobe && <ModalFrame onClose={() => setEditingWardrobe(null)} panelClassName="compact-modal wardrobe-edit-modal"><button className="modal-close" onClick={() => setEditingWardrobe(null)}>×</button><span className="micro-label">EDIT GARMENT</span><h3>修改衣物信息</h3><div className="edit-garment-preview transparent-grid"><img src={editingWardrobe.imageUrl} alt={editingWardrobe.name} /></div><div className="profile-form"><label>衣物名称<input value={editingWardrobe.name} onChange={event => setEditingWardrobe({ ...editingWardrobe, name: event.target.value })} /></label><label>分类<select value={editingWardrobe.category} onChange={event => setEditingWardrobe({ ...editingWardrobe, category: event.target.value })}>{["上衣", "外套", "下装", "连衣裙", "鞋履", "配饰", "帽子"].map(value => <option key={value}>{value}</option>)}</select></label><label>颜色<input value={editingWardrobe.colorName} onChange={event => setEditingWardrobe({ ...editingWardrobe, colorName: event.target.value })} /></label><label>季节<select value={editingWardrobe.season} onChange={event => setEditingWardrobe({ ...editingWardrobe, season: event.target.value })}>{["四季", "春秋", "夏季", "冬季"].map(value => <option key={value}>{value}</option>)}</select></label><label>风格<select value={editingWardrobe.style} onChange={event => setEditingWardrobe({ ...editingWardrobe, style: event.target.value })}>{["简约", "通勤", "休闲", "运动", "复古", "甜酷"].map(value => <option key={value}>{value}</option>)}</select></label></div><div className="edit-ai-tags-wrap"><span className="micro-label">AI MATCHING TAGS</span><div className="edit-ai-tags">{garmentTagLabels(editingWardrobe.aiTags).map(tag => <span key={tag}>{tag}</span>)}<span>正式度 {editingWardrobe.aiTags.formality}/5</span><span>保暖度 {editingWardrobe.aiTags.warmth}/5</span></div><small>用于天气、场合、层次与风格筛选，后续由搭配模型综合评分。</small></div><button className="primary-modal-button" onClick={() => updateWardrobeItem(editingWardrobe.id, editingWardrobe)}>保存修改</button></ModalFrame>}

      {showWeather && <ModalFrame onClose={() => setShowWeather(false)} panelClassName="compact-modal"><button className="modal-close" onClick={() => setShowWeather(false)}>×</button><span className="micro-label">WEATHER & LOCATION</span><h3>天气与城市</h3><p>允许定位后会自动获取当前位置；拒绝定位时使用常驻城市。天气会在后台参与搭配，不需要重复填写。</p><button className="location-button" onClick={locateWeather}>⌖ 允许定位并获取天气</button><div className="city-grid">{["杭州", "上海", "北京", "广州", "深圳", "成都"].map(item => <button key={item} className={city === item ? "active" : ""} onClick={() => { setCity(item); setShowWeather(false); notify(`常驻城市已设为${item}`); }}>{item}</button>)}</div></ModalFrame>}

      {showProfileEdit && <ModalFrame onClose={() => setShowProfileEdit(false)} panelClassName="compact-modal profile-edit-modal"><button className="modal-close" onClick={() => setShowProfileEdit(false)}>×</button><span className="micro-label">EDIT PROFILE</span><h3>编辑个人信息</h3><div className="profile-form"><label>昵称<input value={profile.nickname} onChange={event => setProfile(value => ({ ...value, nickname: event.target.value }))} /></label><label>性别<select value={profile.gender} onChange={event => setProfile(value => ({ ...value, gender: event.target.value }))}><option>女</option><option>男</option><option>其他</option></select></label><label>身高（cm）<input value={profile.height} onChange={event => setProfile(value => ({ ...value, height: event.target.value }))} /></label><label>体重（kg）<input value={profile.weight} onChange={event => setProfile(value => ({ ...value, weight: event.target.value }))} /></label><label>身材比例<select value={profile.bodyType} onChange={event => setProfile(value => ({ ...value, bodyType: event.target.value }))}><option>直筒型</option><option>梨形</option><option>苹果型</option><option>沙漏型</option><option>倒三角</option></select></label></div><button className="optional-photo" onClick={() => modelFileRef.current?.click()}>＋ {modelProfile ? "更换个人全身照" : "上传个人全身照"}</button><button className="primary-modal-button" onClick={() => { saveProfile(profile, stylePrefs); setShowProfileEdit(false); notify("个人信息已保存"); }}>保存资料</button></ModalFrame>}
      {toast && <div className="toast"><Icon name="check" /> {toast}</div>}
    </main>
  );
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
      <div className="real-look-copy"><h4>{look.title}</h4><p>{look.reason}</p><div>{look.highlights.map(tag => <span key={tag}>{tag}</span>)}</div>{look.missingSuggestion && <small>可选添置：{look.missingSuggestion}</small>}</div>
      <span className="real-look-select">{selectedId === look.id ? "✓ 已选择" : "选择这套"}</span>
    </button>)}</div>
    <button className="model-button" disabled={!selectedId || tryOnLoading} onClick={modelReady ? generateTryOn : openModelUpload}>{!selectedId ? "先选择一套喜欢的穿搭" : tryOnLoading ? "正在生成个人效果图…" : modelReady ? "用我的全身照生成效果图" : "上传全身照后生成效果图"}</button>
    <section className="chat-assistant"><div className="chat-title"><span><Icon name="spark" /></span><div><b>继续和易搭聊</b><small>可以持续调整颜色、单品与正式程度</small></div></div><div className="chat-messages">{chatMessages.map((message, index) => <p key={`${message.role}-${index}`} className={message.role}>{message.text}</p>)}{chatTyping && <p className="assistant typing">正在想…</p>}</div><div className="chat-quick">{["换双鞋", "更正式一点", "颜色再克制些"].map(item => <button key={item} onClick={() => setChatInput(item)}>{item}</button>)}</div><div className="chat-input"><input value={chatInput} onChange={event => setChatInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") sendChat(); }} placeholder="例如：用这件外套重新搭一套" /><button onClick={sendChat}>发送</button></div></section>
  </section>;
}

function ShortcutSection({ setTab }: { setTab: (tab: Tab) => void }) {
  const items: Array<{ tab: Tab; icon: string; title: string; desc: string }> = [
    { tab: "wardrobe", icon: "wardrobe", title: "整理衣柜", desc: "上传、分类和管理衣物" },
    { tab: "create", icon: "create", title: "自主搭配", desc: "自己选衣服，让 AI 点评" },
    { tab: "inspiration", icon: "gallery", title: "寻找灵感", desc: "浏览并复刻喜欢的风格" },
  ];
  return <section className="shortcut-section clean-shortcuts"><div className="shortcut-heading"><div><span>MORE TOOLS</span><h2>常用功能</h2></div></div><div className="utility-grid">{items.map(item => <button key={item.tab} onClick={() => setTab(item.tab)}><i><Icon name={item.icon} /></i><span><b>{item.title}</b><small>{item.desc}</small></span><strong>→</strong></button>)}</div></section>;
}
