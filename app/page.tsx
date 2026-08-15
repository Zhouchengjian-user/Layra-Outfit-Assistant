"use client";

import { useEffect, useRef, useState } from "react";

type Tab = "home" | "wardrobe" | "create" | "inspiration" | "profile";
type Scene = "通勤" | "约会" | "休闲" | "聚会" | "运动" | "正式活动";
type Scope = "仅个人衣柜" | "衣柜＋建议添置" | "灵感扩展";
type Feedback = "like" | "dislike";
type ChatMessage = { role: "user" | "assistant"; text: string };

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
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [closetFilter, setClosetFilter] = useState("全部");
  const [selectedItems, setSelectedItems] = useState<number[]>([1, 4, 5]);
  const [showReview, setShowReview] = useState(false);
  const [toast, setToast] = useState("");
  const [feedback, setFeedback] = useState<Record<number, Feedback>>({});
  const [savedLooks, setSavedLooks] = useState<number[]>([]);
  const [washingItems, setWashingItems] = useState<number[]>([3]);
  const [hiddenItems, setHiddenItems] = useState<number[]>([]);
  const [editingGarment, setEditingGarment] = useState<number | null>(null);
  const [garmentNames, setGarmentNames] = useState<Record<number, string>>({});
  const [draftGarmentName, setDraftGarmentName] = useState("");
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

  useEffect(() => {
    const timer = setInterval(() => setPromptIndex(value => (value + 1) % prompts.length), 2800);
    return () => clearInterval(timer);
  }, []);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };

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

  const handleUpload = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files).slice(0, 5).map(file => URL.createObjectURL(file));
    setUploaded(current => [...current, ...next]);
    notify(`已识别 ${next.length} 件衣物，去背景、分类和颜色标签已完成`);
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

  const openGarmentEdit = (id: number) => {
    const item = garments.find(g => g.id === id);
    if (!item) return;
    setEditingGarment(id); setDraftGarmentName(garmentNames[id] || item.name);
  };

  const saveGarmentEdit = () => {
    if (editingGarment === null) return;
    setGarmentNames(current => ({ ...current, [editingGarment]: draftGarmentName.trim() || current[editingGarment] }));
    setEditingGarment(null); notify("衣物信息已更新");
  };

  const activeGarments = garments.filter(item => !hiddenItems.includes(item.id));
  const filters = ["全部", "上衣", "下装", "鞋履", "配饰", "帽子"];
  const filtered = (closetFilter === "全部" ? activeGarments : activeGarments.filter(item => item.type === closetFilter));

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
      <button className="quick-start-mobile" onClick={() => { setPrompt("用示例衣柜推荐一套适合今天的穿搭"); generateLooks(); }}><span>✦</span><div><b>还没上传衣服？先快速体验</b><small>使用示例衣柜生成今日穿搭</small></div><i>→</i></button>
      <section className="prompt-card">
        <div className="prompt-head"><span><Icon name="spark" /> AI 穿搭灵感</span><b>剩余 {generationsLeft} / 5 次</b></div>
        <div className="scope-row">{scopes.map(item => <button key={item} className={scope === item ? "active" : ""} onClick={() => setScope(item)}>{item}</button>)}</div>
        <div className="scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
        <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="输入穿搭需求" />
        <button className="generate-button" onClick={generateLooks} disabled={loading}>{loading ? <><span className="spinner" />正在翻你的衣柜...</> : <>生成今日穿搭 <Icon name="arrow" /></>}</button>
      </section>
      {!showResults && !loading && <section className="closet-glance"><div className="section-heading"><div><span className="micro-label">MY CLOSET</span><h3>衣柜里有 {activeGarments.length + 24} 件衣服</h3></div><button onClick={() => setTab("wardrobe")}>去看看 →</button></div><div className="glance-grid">{activeGarments.slice(0, 4).map(item => <div key={item.id}><GarmentArt color={item.color} /><span>{item.type}</span></div>)}</div></section>}
      {loading && <Thinking />}
      <div className="results-anchor" />
      {showResults && resultsBlock}
    </div>
  );

  return (
    <main className={`site-shell ${loading ? "is-thinking" : ""}`}>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={event => handleUpload(event.target.files)} />

      <aside className="desktop-sidebar">
        <button className="side-logo" onClick={() => setTab("home")} aria-label="易搭首页"><img src="/yida-logo.png" alt="易搭" /></button>
        <nav>
          <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><Icon name="home" /><small>今日</small></button>
          <button className={tab === "wardrobe" ? "active" : ""} onClick={() => setTab("wardrobe")}><Icon name="wardrobe" /><small>衣柜</small></button>
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}><Icon name="create" /><small>搭配</small></button>
          <button className={tab === "inspiration" ? "active" : ""} onClick={() => setTab("inspiration")}><Icon name="gallery" /><small>灵感</small></button>
        </nav>
        <div className="sidebar-bottom"><button onClick={() => notify("有问题？告诉易搭就好")}><Icon name="help" /><small>帮助</small></button><button className="side-avatar" onClick={() => setTab("profile")}>{profile.nickname.slice(0, 1)}</button></div>
      </aside>

      <header className="desktop-topbar">
        <button className="workspace-switch"><img src="/yida-logo.png" alt="" /><span>AI OUTFIT STUDIO</span><b>易搭 · {profile.nickname}的衣橱</b><i>⌄</i></button>
        <div className="topbar-meta"><button className="weather-pill" onClick={() => setShowWeather(true)}><Icon name="sun" /> {city} 27° · 小雨</button><span>今日剩余 {generationsLeft} / 5 次</span><button onClick={() => setTab("profile")}>个人中心</button></div>
      </header>

      <section className="studio-surface">
        {tab === "home" && <><div className="desktop-home">
          <div className="hero-copy"><span>易搭 · YOUR CLOSET, REIMAGINED</span><h1>今天，想穿成什么样？</h1><p>告诉易搭你想怎么穿，它会从你的衣柜里挑出三套搭配方案。</p></div>
          <div className="desktop-scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
          <div className="scope-switch"><span>推荐范围</span>{scopes.map(item => <button key={item} className={scope === item ? "active" : ""} onClick={() => setScope(item)}>{item}</button>)}</div>
          <section className="studio-composer"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="描述今天想要的穿搭" /><div className="composer-actions"><button className="upload-button" onClick={() => fileRef.current?.click()}><Icon name="camera" /> 添加衣服 <span>⌄</span></button><div><button className="tune-button" onClick={() => setShowWeather(true)}><Icon name="tune" /></button><button className="generate-button" onClick={generateLooks} disabled={loading}><Icon name="spark" /> {loading ? "搭配中..." : "生成三套穿搭"}</button></div></div></section>
          <div className="suggestion-row">{suggestions.map((item, index) => <button key={item} onClick={() => setPrompt(item)}><span>{["🧥", "🌷", "☕", "☔"][index]}</span>{item}</button>)}</div>
          {loading && <Thinking />}
          <div className="results-anchor" />
          {showResults ? resultsBlock : <><section className="quick-start-panel"><div><span>NEW USER QUICK START</span><h3>还没有自己的衣柜？</h3><p>先用 12 件示例基础款体验完整推荐流程，之后再慢慢上传也可以。</p></div><button onClick={() => { setPrompt("用示例衣柜推荐今天的穿搭"); generateLooks(); }}>使用示例衣柜体验 →</button></section><ShortcutSection setTab={setTab} generateLooks={generateLooks} setSelectedLook={setSelectedLook} setShowModel={setShowModel} /></>}
        </div>{mobileHome}</>}

        {tab === "wardrobe" && <div className="screen wardrobe-screen">
          <header className="sub-header"><div><span className="micro-label">MY CLOSET</span><h2>我的衣柜 <sup>{activeGarments.length + uploaded.length}</sup></h2></div><button className="round-add" onClick={() => fileRef.current?.click()}>+</button></header>
          <div className="closet-status"><span><b>{activeGarments.length + uploaded.length}</b> 件可穿</span><span><b>{washingItems.length}</b> 件清洗中</span><span><b>5</b> 个自动标签</span></div>
          <button className="upload-zone" onClick={() => fileRef.current?.click()}><span className="upload-icon"><Icon name="camera" /></span><b>拍照或从相册上传衣物</b><small>AI 自动去背景、识别分类、颜色、季节与风格 · 支持一次上传 3–5 件</small></button>
          <div className="filter-row">{filters.map(filter => <button key={filter} className={closetFilter === filter ? "active" : ""} onClick={() => setClosetFilter(filter)}>{filter}</button>)}</div>
          <div className="wardrobe-grid">
            {uploaded.map((src, index) => <article className="wardrobe-item" key={src}><div className="uploaded-wrap"><img src={src} alt={`新上传衣物 ${index + 1}`} /><span className="ai-tag">AI 已识别</span></div><b>新衣物</b><small>待确认 · 自动去背景</small><div className="wardrobe-actions"><button onClick={() => notify("已确认衣物信息")}>确认</button><button onClick={() => setUploaded(current => current.filter(item => item !== src))}>删除</button></div></article>)}
            {filtered.map(item => <article className={`wardrobe-item ${washingItems.includes(item.id) ? "is-washing" : ""}`} key={item.id}><div className="wardrobe-art"><GarmentArt color={item.color} />{washingItems.includes(item.id) && <span className="washing-badge">清洗中</span>}</div><b>{garmentNames[item.id] || item.name}</b><small>{item.meta} · {item.season}</small><div className="wardrobe-actions"><button onClick={() => openGarmentEdit(item.id)}>编辑</button><button onClick={() => setWashingItems(current => current.includes(item.id) ? current.filter(id => id !== item.id) : [...current, item.id])}>{washingItems.includes(item.id) ? "恢复" : "清洗"}</button><button onClick={() => { setHiddenItems(current => [...current, item.id]); notify("衣物已移出衣柜"); }}>删除</button></div></article>)}
          </div>
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

      {showWeather && <div className="modal-backdrop" onClick={() => setShowWeather(false)}><section className="modal compact-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowWeather(false)}>×</button><span className="micro-label">WEATHER & LOCATION</span><h3>天气与城市</h3><p>允许定位后会自动获取当前位置；拒绝定位时使用常驻城市。</p><button className="location-button" onClick={() => { setCity("杭州"); notify("已获取当前位置：杭州"); setShowWeather(false); }}>⌖ 允许定位并获取天气</button><div className="city-grid">{["杭州", "上海", "北京", "广州", "深圳", "成都"].map(item => <button key={item} className={city === item ? "active" : ""} onClick={() => { setCity(item); setShowWeather(false); notify(`常驻城市已设为${item}`); }}>{item}</button>)}</div></section></div>}

      {editingGarment !== null && <div className="modal-backdrop" onClick={() => setEditingGarment(null)}><section className="modal compact-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setEditingGarment(null)}>×</button><span className="micro-label">EDIT GARMENT</span><h3>修改衣物信息</h3><label className="field-label">衣物名称<input value={draftGarmentName} onChange={event => setDraftGarmentName(event.target.value)} /></label><div className="auto-tags"><span>AI 分类：{garments.find(item => item.id === editingGarment)?.type}</span><span>颜色：{garments.find(item => item.id === editingGarment)?.meta.split(" · ")[0]}</span><span>季节：{garments.find(item => item.id === editingGarment)?.season}</span></div><button className="primary-modal-button" onClick={saveGarmentEdit}>保存修改</button></section></div>}

      {showProfileEdit && <div className="modal-backdrop" onClick={() => setShowProfileEdit(false)}><section className="modal compact-modal profile-edit-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowProfileEdit(false)}>×</button><span className="micro-label">EDIT PROFILE</span><h3>编辑个人信息</h3><div className="profile-form"><label>昵称<input value={profile.nickname} onChange={event => setProfile(value => ({ ...value, nickname: event.target.value }))} /></label><label>性别<select value={profile.gender} onChange={event => setProfile(value => ({ ...value, gender: event.target.value }))}><option>女</option><option>男</option><option>其他</option></select></label><label>身高（cm）<input value={profile.height} onChange={event => setProfile(value => ({ ...value, height: event.target.value }))} /></label><label>体重（kg）<input value={profile.weight} onChange={event => setProfile(value => ({ ...value, weight: event.target.value }))} /></label><label>身材比例<select value={profile.bodyType} onChange={event => setProfile(value => ({ ...value, bodyType: event.target.value }))}><option>直筒型</option><option>梨形</option><option>苹果型</option><option>沙漏型</option><option>倒三角</option></select></label></div><button className="optional-photo" onClick={() => fileRef.current?.click()}>＋ 上传全身照（可选）</button><button className="primary-modal-button" onClick={() => { setShowProfileEdit(false); notify("个人信息已保存"); }}>保存资料</button></section></div>}
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

function ShortcutSection({ setTab, generateLooks, setSelectedLook, setShowModel }: { setTab: (tab: Tab) => void; generateLooks: () => void; setSelectedLook: (id: number) => void; setShowModel: (show: boolean) => void }) {
  return <section className="shortcut-section"><div className="shortcut-heading"><div><span>STUDIO SHORTCUTS</span><h2>穿搭工作室</h2></div><p>衣柜已有 32 件单品 · 支持连续调整与收藏</p></div><div className="shortcut-grid"><button className="shortcut-card card-today" onClick={generateLooks}><div className="shortcut-art garment-collage">{garments.slice(0, 4).map(item => <GarmentArt key={item.id} color={item.color} />)}</div><span><Icon name="spark" /> 今日穿搭</span><b>让 AI 从你的衣柜里搭出今天</b><small>天气 × 场合 × 你的偏好</small></button><button className="shortcut-card card-create" onClick={() => setTab("create")}><div className="shortcut-art mini-canvas">{[1, 4, 5].map(id => <GarmentArt key={id} color={garments.find(item => item.id === id)!.color} />)}</div><span>＋ 个人搭配</span><b>你来选，AI 做轻松点评</b><small>颜色、比例、天气与场合</small></button><button className="shortcut-card card-model" onClick={() => { setSelectedLook(1); setShowModel(true); }}><div className="model-card-image"><i /><em /></div><span>♙ AI 模特</span><b>看看衣服穿上身的样子</b><small>系统模特 · 近似你的体型</small></button><button className="shortcut-card card-closet" onClick={() => setTab("wardrobe")}><div className="shortcut-art closet-collage">{garments.slice(4, 8).map(item => <GarmentArt key={item.id} color={item.color} />)}</div><span><Icon name="wardrobe" /> 我的衣柜</span><b>拍照上传，AI 自动整理</b><small>去背景 · 分类 · 识别颜色</small></button></div></section>;
}
