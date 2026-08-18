"use client";

import { useEffect, useRef, useState } from "react";
import { processGarmentUpload, type ProcessedGarmentImage } from "./lib/garment-image";
import { garmentTagLabels, type GarmentAITags } from "./lib/garment-tags";

type Tab = "home" | "wardrobe" | "create" | "inspiration" | "profile";
type Scene = "通勤" | "约会" | "休闲" | "聚会" | "运动" | "正式活动";
type Scope = "仅个人衣柜" | "衣柜＋建议添置" | "灵感扩展";
type Feedback = "like" | "dislike";
type ChatMessage = { role: "user" | "assistant"; text: string };
type WardrobeItem = {
  id: string; name: string; category: string; colorName: string; colorHex: string;
  season: string; style: string; status: "available" | "washing"; createdAt: number; imageUrl: string; aiTags: GarmentAITags; tagVersion: number;
};
type GarmentDraft = ProcessedGarmentImage & { id: string; selected: boolean };

const scenes: Scene[] = ["通勤", "约会", "休闲", "聚会", "运动", "正式活动"];
const scopes: Scope[] = ["仅个人衣柜", "衣柜＋建议添置", "灵感扩展"];
const prompts = ["帮我推荐今日穿搭", "今天想穿得松弛又精神", "晚上的约会怎么穿？", "帮我搭一套显比例的通勤装"];
const suggestions = ["帮我推荐今日穿搭", "今晚约会，想穿得温柔一点", "通勤但不要太正式", "下雨天也要显比例"];
const styleOptions = ["简约", "松弛感", "轻复古", "通勤", "运动", "甜酷"];

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

const looks = [
  { id: 1, label: "松弛通勤", note: "清爽，有点小讲究", score: 94, colors: ["cream", "olive", "charcoal", "caramel"], tags: ["显比例", "办公室友好"] },
  { id: 2, label: "轻盈层次", note: "温柔但不无聊", score: 91, colors: ["cream", "denim", "white", "wine"], tags: ["清爽", "适合小雨"] },
  { id: 3, label: "利落松弛", note: "下班也可以直接去约会", score: 89, colors: ["olive", "denim", "black", "white"], tags: ["轻复古", "不费力"] },
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
    home: "⌂", wardrobe: "▦", create: "+", profile: "♙", gallery: "▧", help: "?", history: "↺",
    sun: "☼", spark: "✦", camera: "◉", check: "✓", arrow: "→", tune: "⌘", heart: "♡", calendar: "□",
  };
  return <span aria-hidden="true">{icons[name] || "·"}</span>;
}

function GarmentArt({ color, mini = false }: { color: string; mini?: boolean }) {
  return <div className={`garment-art ${color} ${mini ? "mini" : ""}`}><span className="garment-neck" /><span className="garment-body" /><span className="garment-detail" /></div>;
}

function OutfitCard({ look, active, onClick }: { look: typeof looks[0]; active?: boolean; onClick: () => void }) {
  return (
    <button className={`outfit-card ${active ? "active" : ""}`} onClick={onClick} aria-label={`选择${look.label}`}>
      <div className="outfit-topline"><span>LOOK 0{look.id}</span><b>{look.score}<i>分</i></b></div>
      <div className="outfit-board">{look.colors.map((color, index) => <GarmentArt key={`${color}-${index}`} color={color} mini />)}</div>
      <div className="outfit-copy"><strong>{look.label}</strong><p>{look.note}</p><div className="tag-row">{look.tags.map(tag => <span key={tag}>{tag}</span>)}</div></div>
    </button>
  );
}

function BottomNav({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  const items: Array<{ id: Tab; name: string; icon: string }> = [
    { id: "home", name: "今日", icon: "home" }, { id: "wardrobe", name: "衣柜", icon: "wardrobe" },
    { id: "create", name: "搭配", icon: "create" }, { id: "inspiration", name: "灵感", icon: "gallery" },
    { id: "profile", name: "我的", icon: "profile" },
  ];
  return <nav className="bottom-nav" aria-label="主导航">{items.map(item => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} /><small>{item.name}</small></button>)}</nav>;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("home");
  const [promptIndex, setPromptIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [scene, setScene] = useState<Scene>("通勤");
  const [scope, setScope] = useState<Scope>("仅个人衣柜");
  const [selectedLook, setSelectedLook] = useState<number | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generationsLeft, setGenerationsLeft] = useState(3);
  const [wardrobeItems, setWardrobeItems] = useState<WardrobeItem[]>([]);
  const [wardrobeLoading, setWardrobeLoading] = useState(true);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadProcessing, setUploadProcessing] = useState(false);
  const [uploadSaving, setUploadSaving] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [garmentDrafts, setGarmentDrafts] = useState<GarmentDraft[]>([]);
  const [editingWardrobe, setEditingWardrobe] = useState<WardrobeItem | null>(null);
  const [closetFilter, setClosetFilter] = useState("全部");
  const [selectedItems, setSelectedItems] = useState<number[]>([1, 4, 5]);
  const [showReview, setShowReview] = useState(false);
  const [toast, setToast] = useState("");
  const [feedback, setFeedback] = useState<Record<number, Feedback>>({});
  const [savedLooks, setSavedLooks] = useState<number[]>([]);
  const [washingItems, setWashingItems] = useState<number[]>([3]);
  const [stylePrefs, setStylePrefs] = useState<string[]>(["松弛感", "简约"]);
  const [city, setCity] = useState("杭州");
  const [showWeather, setShowWeather] = useState(false);
  const [showProfileEdit, setShowProfileEdit] = useState(false);
  const [profile, setProfile] = useState({ nickname: "阿禾", gender: "女", height: "168", weight: "55", bodyType: "直筒型" });
  const [chatInput, setChatInput] = useState("");
  const [chatTyping, setChatTyping] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([{ role: "assistant", text: "三套都来自你的衣柜。想换颜色、鞋子或调整正式程度，直接告诉我。" }]);
  const [history, setHistory] = useState([{ id: 1, scene: "约会", text: "温柔一点但不要太甜", date: "昨天" }, { id: 2, scene: "通勤", text: "舒服又显比例", date: "8月13日" }]);
  const [planned, setPlanned] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadModeRef = useRef<"replace" | "append">("replace");
  const uploadBatchRef = useRef(0);

  useEffect(() => {
    const timer = setInterval(() => setPromptIndex(value => (value + 1) % prompts.length), 2800);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/wardrobe")
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "衣柜加载失败");
        if (active) setWardrobeItems(payload.items || []);
      })
      .catch(() => { if (active) notify("衣柜暂时没有同步成功，请稍后重试"); })
      .finally(() => { if (active) setWardrobeLoading(false); });
    return () => { active = false; };
  }, []);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };

  const openUploadPicker = (mode: "replace" | "append" = "replace") => {
    uploadModeRef.current = mode;
    fileRef.current?.click();
  };

  const generateLooks = () => {
    if (generationsLeft <= 0) { notify("今天的生成次数已用完，明天 00:00 恢复"); return; }
    setLoading(true); setShowResults(false);
    window.setTimeout(() => {
      setLoading(false); setShowResults(true); setSelectedLook(null);
      setGenerationsLeft(value => Math.max(0, value - 1));
      setHistory(current => [{ id: Date.now(), scene, text: prompt || `${scene}穿搭推荐`, date: "刚刚" }, ...current].slice(0, 6));
      window.setTimeout(() => document.querySelector(".results-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }, 1050);
  };

  const handleUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files).filter(file => file.type.startsWith("image/")).slice(0, 5);
    if (!selected.length) return;
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
            const response = await fetch("/api/wardrobe", { method: "POST", body: form });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error || "保存失败");
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

  const updateWardrobeItem = async (id: string, patch: Partial<WardrobeItem>) => {
    const response = await fetch("/api/wardrobe", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...patch }) });
    const payload = await response.json();
    if (!response.ok) { notify(payload.error || "更新失败"); return; }
    setWardrobeItems(current => current.map(item => item.id === id ? payload.item : item));
    setEditingWardrobe(null);
    notify("衣物信息已更新");
  };

  const deleteWardrobeItem = async (item: WardrobeItem) => {
    if (!window.confirm(`确定从衣柜删除“${item.name}”吗？`)) return;
    setWardrobeItems(current => current.filter(value => value.id !== item.id));
    notify("衣物已从衣柜删除");
    try {
      const response = await fetch(`/api/wardrobe?id=${encodeURIComponent(item.id)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "删除失败");
    } catch (error) {
      setWardrobeItems(current => current.some(value => value.id === item.id)
        ? current
        : [...current, item].sort((a, b) => b.createdAt - a.createdAt));
      notify(error instanceof Error ? `${error.message}，衣物已恢复` : "删除失败，衣物已恢复");
    }
  };

  const toggleFeedback = (lookId: number, value: Feedback) => {
    setFeedback(current => ({ ...current, [lookId]: current[lookId] === value ? undefined as never : value }));
    notify(value === "like" ? "收到，易搭会多推荐这种风格" : "收到，易搭会减少类似搭配");
  };

  const toggleSaveLook = (lookId: number) => {
    setSavedLooks(current => current.includes(lookId) ? current.filter(id => id !== lookId) : [...current, lookId]);
    notify(savedLooks.includes(lookId) ? "已取消收藏" : "已收藏到「我的搭配」");
  };

  const sendChat = () => {
    const value = chatInput.trim();
    if (!value) return;
    setChatMessages(current => [...current, { role: "user", text: value }]);
    setChatInput(""); setChatTyping(true);
    window.setTimeout(() => {
      const answer = value.includes("正式") ? "可以。我会保留上衣和鞋子，把下装换成炭灰阔腿裤，正式一点但不会显老气。" : value.includes("颜色") ? "没问题。第二套可以把酒红包换成黑色帽子，整体会更克制。" : "懂了。我会保留你喜欢的比例，重新调整单品组合。要不要我再生成一组？";
      setChatMessages(current => [...current, { role: "assistant", text: answer }]); setChatTyping(false);
    }, 650);
  };

  const activeGarments = garments;
  const filters = ["全部", "上衣", "外套", "下装", "鞋履", "配饰", "帽子"];
  const filteredWardrobe = closetFilter === "全部" ? wardrobeItems : wardrobeItems.filter(item => item.category === closetFilter);
  const cycleScope = () => setScope(scopes[(scopes.indexOf(scope) + 1) % scopes.length]);

  const resultsBlock = (
    <Results
      scene={scene} scope={scope} selectedLook={selectedLook} setSelectedLook={setSelectedLook}
      generateLooks={generateLooks} setShowModel={setShowModel} feedback={feedback}
      toggleFeedback={toggleFeedback} savedLooks={savedLooks} toggleSaveLook={toggleSaveLook}
      chatMessages={chatMessages} chatInput={chatInput} setChatInput={setChatInput} sendChat={sendChat} chatTyping={chatTyping}
    />
  );

  const mobileHome = (
    <div className="screen home-screen mobile-home">
      <header className="app-header"><div className="mobile-brand"><img src="/yida-logo.png" alt="易搭" /><div><span className="micro-label">易搭 · THURSDAY, 13 AUG</span><h2>早上好，{profile.nickname}</h2></div></div><button className="avatar" onClick={() => setTab("profile")}>{profile.nickname.slice(0, 1)}</button></header>
      <button className="weather-strip" onClick={() => setShowWeather(true)}><div className="weather-icon"><Icon name="sun" /></div><div><b>{city} 27° / 有小雨</b><span>天气已同步 · 体感闷热</span></div><small>穿薄层 ›</small></button>
      <section className="prompt-card">
        <div className="prompt-head"><span><Icon name="spark" /> AI 穿搭灵感</span><b>剩余 {generationsLeft} / 5 次</b></div>
        <div className="scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
        <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="输入穿搭需求" />
        <div className="mobile-composer-foot"><button className="mobile-mode-select" onClick={cycleScope}>{scope}⌄</button><button className="generate-button" onClick={generateLooks} disabled={loading}>{loading ? <><span className="spinner" />搭配中...</> : <>生成三套 <Icon name="arrow" /></>}</button></div>
      </section>
      <button className="quick-start-mobile" onClick={() => { setPrompt("用示例衣柜推荐一套适合今天的穿搭"); generateLooks(); }}><span>✦</span><div><b>还没上传衣服？先快速体验</b><small>使用示例衣柜生成今日穿搭</small></div><i>→</i></button>
      {!showResults && !loading && <section className="closet-glance"><div className="section-heading"><div><span className="micro-label">MY CLOSET</span><h3>{wardrobeItems.length ? `衣柜里有 ${wardrobeItems.length} 件衣服` : "从第一件衣服开始建立衣柜"}</h3></div><button onClick={() => setTab("wardrobe")}>{wardrobeItems.length ? "去看看" : "立即上传"} →</button></div>{wardrobeItems.length ? <div className="glance-grid real-glance">{wardrobeItems.slice(0, 4).map(item => <div key={item.id}><img src={item.imageUrl} alt={item.name} /><span>{item.category}</span></div>)}</div> : <div className="closet-empty-glance"><span>＋</span><p>拍一张衣物照片，易搭会自动抠图和整理标签</p></div>}</section>}
      {loading && <Thinking />}
      <div className="results-anchor" />
      {showResults && resultsBlock}
    </div>
  );

  return (
    <main className={`site-shell ${loading ? "is-thinking" : ""}`}>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={event => handleUpload(event.target.files)} />

      <aside className="desktop-sidebar">
        <div className="side-brand"><button className="side-logo" onClick={() => setTab("home")} aria-label="易搭首页"><img src="/yida-logo.png" alt="易搭" /></button><strong>易搭</strong><button className="collapse-side" onClick={() => notify("移动端将自动收起侧栏")}>‹</button></div>
        <nav>
          <button className={tab === "home" ? "active primary" : "primary"} onClick={() => setTab("home")}><Icon name="spark" /><span>今日推荐</span></button>
          <button className={tab === "wardrobe" ? "active" : ""} onClick={() => setTab("wardrobe")}><Icon name="wardrobe" /><span>我的衣柜</span></button>
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}><Icon name="create" /><span>自主搭配</span></button>
          <button className={tab === "inspiration" ? "active" : ""} onClick={() => setTab("inspiration")}><Icon name="gallery" /><span>穿搭灵感</span></button>
          <button className={tab === "profile" ? "active" : ""} onClick={() => setTab("profile")}><Icon name="profile" /><span>我的</span></button>
        </nav>
        <button className="preference-progress" onClick={() => setTab("profile")}><i><em /></i><span><b>完善穿搭偏好</b><small>已完成 {stylePrefs.length} / 6</small></span><strong>›</strong></button>
        <div className="sidebar-recent"><div><b>近期</b><button onClick={() => setTab("profile")}>⌃</button></div>{history.slice(0, 3).map(item => <button key={item.id} onClick={() => { setScene(item.scene as Scene); setPrompt(item.text); setTab("home"); }}><span>{item.text}</span><small>{item.date}</small></button>)}</div>
        <div className="sidebar-bottom"><button onClick={() => notify("有问题？告诉易搭就好")}><Icon name="help" /><span>帮助与反馈</span></button><button className="side-profile" onClick={() => setTab("profile")}><span className="side-avatar">{profile.nickname.slice(0, 1)}</span><b>{profile.nickname}</b><small>{generationsLeft} 次生成额度</small></button></div>
      </aside>

      <header className="desktop-topbar">
        <div className="topbar-title"><span>{tab === "home" ? "新对话" : tab === "wardrobe" ? "我的衣柜" : tab === "create" ? "个人搭配" : tab === "inspiration" ? "灵感画廊" : "个人中心"}</span></div>
        <div className="topbar-meta"><button className="weather-pill" onClick={() => setShowWeather(true)}>☁ 27°　{city}</button><button className="points-pill" onClick={() => setTab("profile")}>今日剩余 {generationsLeft} 次</button><button className="side-avatar" onClick={() => setTab("profile")}>{profile.nickname.slice(0, 1)}</button></div>
      </header>

      <section className="studio-surface">
        {tab === "home" && <><div className="desktop-home chat-home">
          <div className="hero-copy"><span className="mode-pill">易搭 AI 穿搭助手</span><h1>今天想怎么穿？</h1><p>选择场景，再告诉易搭你的需求。它会从衣柜里挑出三套搭配。</p></div>
          <div className="desktop-scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
          <div className="suggestion-row chat-suggestions">{suggestions.slice(0, 3).map((item, index) => <button key={item} onClick={() => setPrompt(item)}><b>{["舒服又精神", "约会温柔一点", "通勤不太正式"][index]}</b><small>{["今日推荐", "晚餐或看展", "办公室"][index]}</small></button>)}</div>
          <section className="studio-composer chat-composer"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：明天上班，想穿得舒服又有精神" aria-label="描述今天想要的穿搭" /><div className="composer-actions"><div className="composer-left"><button className="add-round" onClick={() => openUploadPicker("replace")}>＋</button><button className="single-scope" onClick={cycleScope}>{scope}<span>⌄</span></button></div><button className="primary-generate" onClick={generateLooks} disabled={loading}>{loading ? "正在搭配…" : "生成 3 套搭配"}<span>→</span></button></div></section>
          {loading && <Thinking />}
          <div className="results-anchor" />
          {showResults ? resultsBlock : <><section className="quick-start-panel"><div><span>第一次使用</span><h3>还没有上传衣服？</h3><p>先用示例衣柜体验推荐，之后再慢慢建立自己的衣柜。</p></div><button onClick={() => { setPrompt("用示例衣柜推荐今天的穿搭"); generateLooks(); }}>快速体验 →</button></section><ShortcutSection setTab={setTab} /></>}
        </div>{mobileHome}</>}

        {tab === "wardrobe" && <div className="screen wardrobe-screen">
          <header className="sub-header"><div><span className="micro-label">MY CLOSET</span><h2>我的衣柜 <sup>{wardrobeItems.length}</sup></h2><p>把真实衣服整理好，之后的搭配才会真正属于你。</p></div><button className="round-add" onClick={() => openUploadPicker("replace")} aria-label="上传衣物">+</button></header>
          <div className="closet-status"><span><b>{wardrobeItems.filter(item => item.status === "available").length}</b> 件可穿</span><span><b>{wardrobeItems.filter(item => item.status === "washing").length}</b> 件清洗中</span><span><b>{new Set(wardrobeItems.flatMap(item => garmentTagLabels(item.aiTags))).size}</b> 个AI搭配标签</span></div>
          <button className="upload-zone" onClick={() => openUploadPicker("replace")}><span className="upload-icon"><Icon name="camera" /></span><span><b>拍照或从相册上传衣物</b><small>自动逐件识别、抠图与整理标签，确认后加入衣柜</small><em>一张图可包含多件单品 · 单次最多 5 张</em></span><strong>开始上传 →</strong></button>
          <div className="wardrobe-toolbar"><div className="filter-row">{filters.map(filter => <button key={filter} className={closetFilter === filter ? "active" : ""} onClick={() => setClosetFilter(filter)}>{filter}</button>)}</div><span>{closetFilter === "全部" ? "全部单品" : closetFilter} · {filteredWardrobe.length}</span></div>
          {wardrobeLoading ? <div className="wardrobe-loading"><span className="spinner" /> 正在同步衣柜…</div> : filteredWardrobe.length ? <div className="wardrobe-grid saved-wardrobe-grid">
            {filteredWardrobe.map(item => <article className={`wardrobe-item saved-garment ${item.status === "washing" ? "is-washing" : ""}`} key={item.id}><div className="uploaded-wrap product-white"><img src={item.imageUrl} alt={item.name} loading="lazy" /><span className="ai-tag">{item.status === "washing" ? "清洗中" : "已入柜"}</span><i className="garment-color-dot" style={{ background: item.colorHex }} /></div><b>{item.name}</b><small>{item.colorName} · {item.category} · {item.season}</small><div className="wardrobe-ai-tags">{garmentTagLabels(item.aiTags).slice(0, 5).map(tag => <span key={tag}>{tag}</span>)}<span>正式 {item.aiTags.formality}/5</span><span>保暖 {item.aiTags.warmth}/5</span></div><div className="wardrobe-actions"><button onClick={() => setEditingWardrobe(item)}>编辑</button><button onClick={() => updateWardrobeItem(item.id, { status: item.status === "washing" ? "available" : "washing" })}>{item.status === "washing" ? "恢复可穿" : "标记清洗"}</button><button onClick={() => deleteWardrobeItem(item)}>删除</button></div></article>)}
          </div> : <section className="wardrobe-empty"><div><span>＋</span></div><h3>{closetFilter === "全部" ? "衣柜还是空的" : `还没有${closetFilter}`}</h3><p>{closetFilter === "全部" ? "先上传一件常穿的衣服。易搭会自动抠掉背景、识别标签，你只需要确认一下。" : "可以切换到全部，或上传一件新的单品。"}</p><button onClick={() => openUploadPicker("replace")}>上传第一件衣服</button></section>}
          <section className="photo-guide"><span className="micro-label">拍得好，抠得更干净</span><div><p><b>01</b> 衣服平铺或挂直</p><p><b>02</b> 背景干净、颜色有反差</p><p><b>03</b> 光线均匀，避免明显阴影</p></div></section>
        </div>}

        {tab === "create" && <div className="screen create-screen">
          <header className="sub-header"><div><span className="micro-label">STYLE IT YOURSELF</span><h2>今天你来搭</h2></div><span className="step-chip">已选 {selectedItems.length} 件</span></header><p className="lead-copy">从衣柜挑出你想穿的，AI 会从颜色、版型、天气与场合四个方面给建议。</p>
          <section className="canvas-card"><div className="canvas-label"><span>你的搭配</span><button onClick={() => setSelectedItems([])}>清空</button></div><div className="canvas-items">{selectedItems.length ? selectedItems.map(id => { const item = garments.find(g => g.id === id)!; return <button key={id} onClick={() => setSelectedItems(items => items.filter(value => value !== id))}><GarmentArt color={item.color} /><span>×</span></button>; }) : <p>轻点下面的单品，把它放进来</p>}</div></section>
          <div className="mini-section-title"><b>从衣柜选择</b><span>全部单品</span></div><div className="pick-grid">{activeGarments.map(item => { const active = selectedItems.includes(item.id); return <button key={item.id} disabled={washingItems.includes(item.id)} className={active ? "active" : ""} onClick={() => setSelectedItems(items => active ? items.filter(id => id !== item.id) : [...items, item.id])}><GarmentArt color={item.color} /><span>{active ? <Icon name="check" /> : washingItems.includes(item.id) ? "洗" : "+"}</span></button>; })}</div>
          <button className="review-button" disabled={selectedItems.length < 2} onClick={() => setShowReview(true)}><Icon name="spark" /> 让 AI 看看这套</button>
        </div>}

        {tab === "inspiration" && <div className="screen inspiration-screen"><header className="sub-header"><div><span className="micro-label">DISCOVER YOUR STYLE</span><h2>穿搭灵感</h2></div><span className="step-chip">为你精选</span></header><p className="lead-copy">喜欢或不感兴趣都会帮助易搭更懂你。收藏后可以直接用自己的衣柜复刻。</p><div className="inspiration-grid">{inspirationThemes.map(theme => <article className="inspiration-card" key={theme.id}><button className="inspiration-visual" onClick={() => { setPrompt(`用我的衣柜复刻${theme.title}`); setTab("home"); }}>{theme.colors.map(color => <GarmentArt key={color} color={color} />)}<span>用我的衣柜复刻 →</span></button><h3>{theme.title}</h3><p>{theme.desc}</p><div><button onClick={() => notify("已加入你的偏好")}>♡ 喜欢</button><button onClick={() => notify("会减少类似灵感")}>不感兴趣</button><button onClick={() => notify("已收藏灵感")}>收藏</button></div></article>)}</div></div>}

        {tab === "profile" && <div className="screen profile-screen">
          <header className="sub-header"><div><span className="micro-label">PROFILE</span><h2>关于{profile.nickname}</h2></div><button className="edit-link" onClick={() => setShowProfileEdit(true)}>编辑资料</button></header>
          <section className="profile-hero"><div className="big-avatar">{profile.nickname.slice(0, 1)}</div><div><h3>{profile.nickname}</h3><p>穿衣要舒服，也要有一点意思。· {city}</p></div></section>
          <section className="body-card"><div><span>性别</span><b>{profile.gender}</b></div><div><span>身高</span><b>{profile.height}<small> cm</small></b></div><div><span>体重</span><b>{profile.weight}<small> kg</small></b></div><div><span>身材比例</span><b>{profile.bodyType}</b></div></section>
          <section className="taste-card"><span className="micro-label">STYLE DNA</span><h3>你的风格偏好</h3><p className="taste-help">点选喜欢的风格，随时可以调整</p><div className="preference-chips">{styleOptions.map(item => <button key={item} className={stylePrefs.includes(item) ? "active" : ""} onClick={() => setStylePrefs(current => current.includes(item) ? current.filter(value => value !== item) : [...current, item])}>{stylePrefs.includes(item) ? "✓ " : "+ "}{item}</button>)}</div></section>
          <div className="profile-feature-grid"><section className="usage-card"><div><span>今日生成额度</span><b>{generationsLeft} / 5</b></div><div className="usage-track"><i style={{ width: `${generationsLeft * 20}%` }} /></div><small>每日 00:00 自动恢复</small></section><section className="points-card"><span>易搭积分</span><b>260</b><small>上传衣服和完善衣柜可获得积分</small><button onClick={() => notify("积分商城将在后续版本开放")}>查看权益 →</button></section></div>
          <section className="profile-section"><div className="section-heading"><div><span className="micro-label">SAVED LOOKS</span><h3>我的搭配</h3></div><span>{savedLooks.length} 套</span></div>{savedLooks.length ? <div className="saved-look-row">{savedLooks.map(id => { const look = looks.find(item => item.id === id)!; return <button key={id} onClick={() => { setSelectedLook(id); setShowModel(true); }}><div>{look.colors.map(color => <GarmentArt key={color} color={color} mini />)}</div><b>{look.label}</b><small>再次查看 →</small></button>; })}</div> : <button className="empty-feature" onClick={() => setTab("home")}>还没有收藏搭配，去生成一套 →</button>}</section>
          <section className="profile-section"><div className="section-heading"><div><span className="micro-label">OUTFIT PLAN</span><h3>穿搭计划</h3></div><Icon name="calendar" /></div><div className="plan-card"><div><b>明天 · 09:00</b><span>项目汇报 · 杭州有小雨</span></div><button className={planned ? "active" : ""} onClick={() => { setPlanned(!planned); notify(planned ? "已取消计划" : "已加入明日穿搭计划"); }}>{planned ? "✓ 已计划" : "生成穿搭"}</button></div></section>
          <section className="profile-section"><div className="section-heading"><div><span className="micro-label">HISTORY · 30 DAYS</span><h3>最近记录</h3></div><Icon name="history" /></div><div className="history-list">{history.map(item => <button key={item.id} onClick={() => { setScene(item.scene as Scene); setPrompt(item.text); setTab("home"); }}><span>{item.date}</span><b>{item.scene}</b><p>{item.text}</p><i>›</i></button>)}</div></section>
          <div className="settings-list"><button onClick={() => setShowWeather(true)}>常驻城市 <span>{city} ›</span></button><button>手机号与微信 <span>已绑定 ›</span></button><button>照片与隐私 <span>已授权 ›</span></button></div>
        </div>}
      </section>

      <BottomNav tab={tab} setTab={setTab} />

      {showModel && <div className="modal-backdrop" onClick={() => setShowModel(false)}><section className="modal model-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowModel(false)}>×</button><div className="model-visual"><div className="model-silhouette"><span className="model-head" /><span className="model-hair" /><span className="model-top" /><span className="model-leg left" /><span className="model-leg right" /><span className="model-shoe left" /><span className="model-shoe right" /></div><span className="model-badge">系统模特 · 近似你的身材比例</span></div><div className="model-copy"><span className="micro-label">AI MODEL PREVIEW</span><h3>这套，穿上比平铺更好看</h3><p>短上衣和高腰阔腿裤把重心提起来了，橄榄绿也很衬你的中性色偏好。小雨天记得带伞，鞋面沾水后及时擦一下。</p><div className="rating-row"><span>颜色协调 <b>96</b></span><span>版型比例 <b>94</b></span><span>天气适配 <b>93</b></span><span>场合适配 <b>92</b></span></div><button onClick={() => { if (selectedLook) toggleSaveLook(selectedLook); setShowModel(false); }}>{selectedLook && savedLooks.includes(selectedLook) ? "取消收藏" : "收藏到我的搭配"}</button></div></section></div>}

      {showReview && <div className="modal-backdrop" onClick={() => setShowReview(false)}><section className="modal review-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowReview(false)}>×</button><span className="review-score">88<small>分</small></span><span className="micro-label">AI OUTFIT REVIEW</span><h3>好看，而且挺像你。</h3><p>奶油白和炭灰很稳，焦糖色鞋子刚好把整套提暖了一点。比例也舒服，通勤穿完全没问题。</p><div className="review-notes"><div><b>颜色协调</b><span>柔和耐看，焦糖色是亮点</span></div><div><b>版型比例</b><span>上短下长，很显腿长</span></div><div><b>天气场合</b><span>适合 20–28℃ 通勤场景</span></div><div><b>可以更好</b><span>如果添一条细皮带，层次会更完整</span></div></div><button onClick={() => { setShowReview(false); setSelectedLook(1); setShowModel(true); }}>生成 AI 模特效果图</button></section></div>}

      {uploadOpen && <div className="modal-backdrop upload-backdrop" onClick={() => { if (!uploadProcessing && !uploadSaving) closeUpload(); }}><section className="modal upload-modal" onClick={event => event.stopPropagation()}><button className="modal-close" disabled={uploadSaving} onClick={closeUpload}>×</button><header className="upload-modal-head"><span className="micro-label">SMART WARDROBE IMPORT</span><h3>{uploadProcessing ? "易搭正在生成高清商品图" : "确认后加入衣柜"}</h3><p>{uploadProcessing ? `正在识别、去除人物并生成高清白底图 ${uploadProgress} / ${Math.max(uploadTotal, 1)} 张` : `已整理 ${garmentDrafts.length} 件单品；点击整张卡片即可切换是否加入衣柜`}</p></header>
        {uploadProcessing && <div className="cutout-progress"><div className="cutout-animation"><span /><i /><b>单品处理中</b></div><p>原图仅用于识别与抠图，只有你确认的白底单品图会加入衣柜。</p></div>}
        {!!garmentDrafts.length && <div className="draft-grid">{garmentDrafts.map(draft => <article className={`garment-draft ${draft.selected ? "selected" : ""} quality-${draft.cutoutQuality}`} key={draft.id} aria-label={`${draft.name}，${draft.selected ? "已选择加入衣柜" : "未选择"}`} onClick={event => { if (draft.cutoutQuality === "failed" || (event.target as HTMLElement).closest("input, select, label")) return; updateGarmentDraft(draft.id, { selected: !draft.selected }); }}><span className="draft-state">{draft.cutoutQuality === "failed" ? "生成失败" : draft.selected ? "✓ 已选择" : "点击选择"}</span><div className="draft-preview product-white"><img src={draft.previewUrl} alt={draft.name} />{draft.cutoutQuality === "review" && <span>原图信息不足，请谨慎确认</span>}{draft.cutoutQuality === "failed" && <span>这是原图裁剪，不会入柜</span>}</div><label>衣物名称<input value={draft.name} onChange={event => updateGarmentDraft(draft.id, { name: event.target.value })} /></label><div className="draft-fields"><label>分类<select value={draft.category} onChange={event => updateGarmentDraft(draft.id, { category: event.target.value })}>{["上衣", "外套", "下装", "连衣裙", "鞋履", "配饰", "帽子"].map(value => <option key={value}>{value}</option>)}</select></label><label>季节<select value={draft.season} onChange={event => updateGarmentDraft(draft.id, { season: event.target.value })}>{["四季", "春秋", "夏季", "冬季"].map(value => <option key={value}>{value}</option>)}</select></label></div><div className="recognized-tags"><span><i style={{ background: draft.colorHex }} />{draft.colorName}</span>{garmentTagLabels(draft.aiTags).slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}<span>正式 {draft.aiTags.formality}/5</span><span>保暖 {draft.aiTags.warmth}/5</span><span>{draft.cutoutQuality === "good" ? "高清商品图" : draft.cutoutQuality === "review" ? "待人工确认" : "未生成商品图"}</span></div></article>)}</div>}
        {!uploadProcessing && <footer className="upload-modal-foot"><button className="secondary-upload" onClick={() => openUploadPicker("append")}>＋ 继续添加</button><button className="primary-upload" disabled={uploadSaving || !garmentDrafts.some(item => item.selected)} onClick={saveGarmentDrafts}>{uploadSaving ? "正在加入衣柜…" : `加入衣柜（${garmentDrafts.filter(item => item.selected).length}）`}</button></footer>}
      </section></div>}

      {editingWardrobe && <div className="modal-backdrop" onClick={() => setEditingWardrobe(null)}><section className="modal compact-modal wardrobe-edit-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setEditingWardrobe(null)}>×</button><span className="micro-label">EDIT GARMENT</span><h3>修改衣物信息</h3><div className="edit-garment-preview transparent-grid"><img src={editingWardrobe.imageUrl} alt={editingWardrobe.name} /></div><div className="profile-form"><label>衣物名称<input value={editingWardrobe.name} onChange={event => setEditingWardrobe({ ...editingWardrobe, name: event.target.value })} /></label><label>分类<select value={editingWardrobe.category} onChange={event => setEditingWardrobe({ ...editingWardrobe, category: event.target.value })}>{["上衣", "外套", "下装", "连衣裙", "鞋履", "配饰", "帽子"].map(value => <option key={value}>{value}</option>)}</select></label><label>颜色<input value={editingWardrobe.colorName} onChange={event => setEditingWardrobe({ ...editingWardrobe, colorName: event.target.value })} /></label><label>季节<select value={editingWardrobe.season} onChange={event => setEditingWardrobe({ ...editingWardrobe, season: event.target.value })}>{["四季", "春秋", "夏季", "冬季"].map(value => <option key={value}>{value}</option>)}</select></label><label>风格<select value={editingWardrobe.style} onChange={event => setEditingWardrobe({ ...editingWardrobe, style: event.target.value })}>{["简约", "通勤", "休闲", "运动", "复古", "甜酷"].map(value => <option key={value}>{value}</option>)}</select></label></div><div className="edit-ai-tags-wrap"><span className="micro-label">AI MATCHING TAGS</span><div className="edit-ai-tags">{garmentTagLabels(editingWardrobe.aiTags).map(tag => <span key={tag}>{tag}</span>)}<span>正式度 {editingWardrobe.aiTags.formality}/5</span><span>保暖度 {editingWardrobe.aiTags.warmth}/5</span></div><small>用于天气、场合、层次与风格筛选，后续由搭配模型综合评分。</small></div><button className="primary-modal-button" onClick={() => updateWardrobeItem(editingWardrobe.id, editingWardrobe)}>保存修改</button></section></div>}

      {showWeather && <div className="modal-backdrop" onClick={() => setShowWeather(false)}><section className="modal compact-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowWeather(false)}>×</button><span className="micro-label">WEATHER & LOCATION</span><h3>天气与城市</h3><p>允许定位后会自动获取当前位置；拒绝定位时使用常驻城市。</p><button className="location-button" onClick={() => { setCity("杭州"); notify("已获取当前位置：杭州"); setShowWeather(false); }}>⌖ 允许定位并获取天气</button><div className="city-grid">{["杭州", "上海", "北京", "广州", "深圳", "成都"].map(item => <button key={item} className={city === item ? "active" : ""} onClick={() => { setCity(item); setShowWeather(false); notify(`常驻城市已设为${item}`); }}>{item}</button>)}</div></section></div>}

      {showProfileEdit && <div className="modal-backdrop" onClick={() => setShowProfileEdit(false)}><section className="modal compact-modal profile-edit-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowProfileEdit(false)}>×</button><span className="micro-label">EDIT PROFILE</span><h3>编辑个人信息</h3><div className="profile-form"><label>昵称<input value={profile.nickname} onChange={event => setProfile(value => ({ ...value, nickname: event.target.value }))} /></label><label>性别<select value={profile.gender} onChange={event => setProfile(value => ({ ...value, gender: event.target.value }))}><option>女</option><option>男</option><option>其他</option></select></label><label>身高（cm）<input value={profile.height} onChange={event => setProfile(value => ({ ...value, height: event.target.value }))} /></label><label>体重（kg）<input value={profile.weight} onChange={event => setProfile(value => ({ ...value, weight: event.target.value }))} /></label><label>身材比例<select value={profile.bodyType} onChange={event => setProfile(value => ({ ...value, bodyType: event.target.value }))}><option>直筒型</option><option>梨形</option><option>苹果型</option><option>沙漏型</option><option>倒三角</option></select></label></div><button className="optional-photo" onClick={() => openUploadPicker("replace")}>＋ 上传全身照（可选）</button><button className="primary-modal-button" onClick={() => { setShowProfileEdit(false); notify("个人信息已保存"); }}>保存资料</button></section></div>}
      {toast && <div className="toast"><Icon name="check" /> {toast}</div>}
    </main>
  );
}

function Thinking() {
  return <section className="ai-thinking" aria-live="polite"><div className="scan-stage"><span className="scan-ring ring-a" /><span className="scan-ring ring-b" /><div className="scan-clothes">{garments.slice(0, 4).map(item => <GarmentArt key={item.id} color={item.color} mini />)}</div><span className="scan-line" /></div><div className="thinking-copy"><span>AI STYLING IN PROGRESS</span><b>正在理解天气、场合和你</b><i><em /></i></div></section>;
}

function Results({ scene, scope, selectedLook, setSelectedLook, generateLooks, setShowModel, feedback, toggleFeedback, savedLooks, toggleSaveLook, chatMessages, chatInput, setChatInput, sendChat, chatTyping }: {
  scene: Scene; scope: Scope; selectedLook: number | null; setSelectedLook: (id: number) => void; generateLooks: () => void; setShowModel: (show: boolean) => void;
  feedback: Record<number, Feedback>; toggleFeedback: (id: number, value: Feedback) => void; savedLooks: number[]; toggleSaveLook: (id: number) => void;
  chatMessages: ChatMessage[]; chatInput: string; setChatInput: (value: string) => void; sendChat: () => void; chatTyping: boolean;
}) {
  return <section className="results-section"><div className="section-heading"><div><span className="micro-label">TODAY&apos;S EDIT</span><h3>{scene}的三种打开方式</h3></div><button onClick={generateLooks}>换一批</button></div><p className="result-context">{scope} · 已结合体感 29°、小雨和你的直筒型身材</p><div className="outfit-list">{looks.map(look => <div className={`outfit-reveal result-card-shell look-${look.id}`} key={look.id}><OutfitCard look={look} active={selectedLook === look.id} onClick={() => setSelectedLook(look.id)} /><div className="result-actions"><button className={feedback[look.id] === "like" ? "active" : ""} onClick={() => toggleFeedback(look.id, "like")}>♡ 喜欢</button><button className={feedback[look.id] === "dislike" ? "active" : ""} onClick={() => toggleFeedback(look.id, "dislike")}>不感兴趣</button><button className={savedLooks.includes(look.id) ? "active" : ""} onClick={() => toggleSaveLook(look.id)}>{savedLooks.includes(look.id) ? "✓ 已收藏" : "收藏"}</button></div></div>)}</div><button className="model-button" disabled={!selectedLook} onClick={() => setShowModel(true)}>{selectedLook ? "在 AI 模特上看看效果" : "先选择一套喜欢的穿搭"}</button><section className="chat-assistant"><div className="chat-title"><span><Icon name="spark" /></span><div><b>继续和易搭聊</b><small>可以持续调整颜色、单品与正式程度</small></div></div><div className="chat-messages">{chatMessages.map((message, index) => <p key={`${message.role}-${index}`} className={message.role}>{message.text}</p>)}{chatTyping && <p className="assistant typing">正在想…</p>}</div><div className="chat-quick">{["换双鞋", "更正式一点", "颜色再克制些"].map(item => <button key={item} onClick={() => setChatInput(item)}>{item}</button>)}</div><div className="chat-input"><input value={chatInput} onChange={event => setChatInput(event.target.value)} onKeyDown={event => { if (event.key === "Enter") sendChat(); }} placeholder="例如：用这件外套重新搭一套" /><button onClick={sendChat}>发送</button></div></section></section>;
}

function ShortcutSection({ setTab }: { setTab: (tab: Tab) => void }) {
  const items: Array<{ tab: Tab; icon: string; title: string; desc: string }> = [
    { tab: "wardrobe", icon: "wardrobe", title: "整理衣柜", desc: "上传、分类和管理衣物" },
    { tab: "create", icon: "create", title: "自主搭配", desc: "自己选衣服，让 AI 点评" },
    { tab: "inspiration", icon: "gallery", title: "寻找灵感", desc: "浏览并复刻喜欢的风格" },
  ];
  return <section className="shortcut-section clean-shortcuts"><div className="shortcut-heading"><div><span>MORE TOOLS</span><h2>常用功能</h2></div></div><div className="utility-grid">{items.map(item => <button key={item.tab} onClick={() => setTab(item.tab)}><i><Icon name={item.icon} /></i><span><b>{item.title}</b><small>{item.desc}</small></span><strong>→</strong></button>)}</div></section>;
}
