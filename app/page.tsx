"use client";

import { useEffect, useRef, useState } from "react";

type Tab = "home" | "wardrobe" | "create" | "profile";
type Scene = "通勤" | "约会" | "休闲" | "聚会" | "运动" | "正式活动";

const scenes: Scene[] = ["通勤", "约会", "休闲", "聚会", "运动", "正式活动"];
const prompts = ["帮我推荐今日穿搭", "今天想穿得松弛又精神", "晚上的约会怎么穿？", "帮我搭一套显比例的通勤装"];
const suggestions = ["帮我推荐今日穿搭", "今晚约会，想穿得温柔一点", "通勤但不要太正式", "下雨天也要显比例"];

const garments = [
  { id: 1, name: "奶油白针织衫", type: "上衣", color: "cream", meta: "奶油白 · 针织" },
  { id: 2, name: "橄榄绿西装", type: "上衣", color: "olive", meta: "橄榄绿 · 西装" },
  { id: 3, name: "浅蓝牛仔裤", type: "下装", color: "denim", meta: "浅蓝 · 牛仔" },
  { id: 4, name: "炭灰阔腿裤", type: "下装", color: "charcoal", meta: "炭灰 · 西裤" },
  { id: 5, name: "焦糖乐福鞋", type: "鞋履", color: "caramel", meta: "焦糖 · 皮革" },
  { id: 6, name: "白色运动鞋", type: "鞋履", color: "white", meta: "白色 · 运动" },
  { id: 7, name: "酒红腋下包", type: "配饰", color: "wine", meta: "酒红 · 皮革" },
  { id: 8, name: "黑色棒球帽", type: "帽子", color: "black", meta: "黑色 · 棉质" },
];

const looks = [
  { id: 1, label: "松弛通勤", note: "清爽，有点小讲究", score: 94, colors: ["cream", "olive", "charcoal", "caramel"], tags: ["显比例", "办公室友好"] },
  { id: 2, label: "轻盈层次", note: "温柔但不无聊", score: 91, colors: ["cream", "denim", "white", "wine"], tags: ["清爽", "适合小雨"] },
  { id: 3, label: "利落松弛", note: "下班也可以直接去约会", score: 89, colors: ["olive", "denim", "black", "white"], tags: ["轻复古", "不费力"] },
];

function Icon({ name }: { name: string }) {
  const icons: Record<string, string> = {
    home: "⌂", wardrobe: "▦", create: "+", profile: "♙", gallery: "▧", help: "?",
    sun: "☼", spark: "✦", camera: "◉", check: "✓", arrow: "→", tune: "⌘",
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
    { id: "create", name: "搭配", icon: "create" }, { id: "profile", name: "我的", icon: "profile" },
  ];
  return <nav className="bottom-nav" aria-label="主导航">{items.map(item => <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><Icon name={item.icon} /><small>{item.name}</small></button>)}</nav>;
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("home");
  const [promptIndex, setPromptIndex] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [scene, setScene] = useState<Scene>("通勤");
  const [selectedLook, setSelectedLook] = useState<number | null>(null);
  const [showResults, setShowResults] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [uploaded, setUploaded] = useState<string[]>([]);
  const [closetFilter, setClosetFilter] = useState("全部");
  const [selectedItems, setSelectedItems] = useState<number[]>([1, 4, 5]);
  const [showReview, setShowReview] = useState(false);
  const [toast, setToast] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setPromptIndex(value => (value + 1) % prompts.length), 2800);
    return () => clearInterval(timer);
  }, []);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2200); };
  const generateLooks = () => {
    setLoading(true); setShowResults(false);
    window.setTimeout(() => {
      setLoading(false); setShowResults(true); setSelectedLook(null);
      window.setTimeout(() => document.querySelector(".results-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }, 1050);
  };
  const handleUpload = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files).slice(0, 4).map(file => URL.createObjectURL(file));
    setUploaded(current => [...current, ...next]);
    notify(`已识别 ${next.length} 件衣物，分类和颜色已自动补全`);
  };

  const filters = ["全部", "上衣", "下装", "鞋履", "配饰", "帽子"];
  const filtered = closetFilter === "全部" ? garments : garments.filter(item => item.type === closetFilter);

  const mobileHome = (
    <div className="screen home-screen mobile-home">
      <header className="app-header"><div><span className="micro-label">THURSDAY, 13 AUG</span><h2>早上好，阿禾</h2></div><button className="avatar" onClick={() => setTab("profile")}>禾</button></header>
      <section className="weather-strip"><div className="weather-icon"><Icon name="sun" /></div><div><b>27° / 有小雨</b><span>天气已自动同步 · 体感闷热</span></div><small>穿薄层</small></section>
      <section className="prompt-card">
        <div className="prompt-head"><span><Icon name="spark" /> AI 穿搭灵感</span><b>今日 3 / 5 次</b></div>
        <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="输入穿搭需求" />
        <div className="scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>
        <button className="generate-button" onClick={generateLooks} disabled={loading}>{loading ? <><span className="spinner" />正在翻你的衣柜...</> : <>生成今日穿搭 <Icon name="arrow" /></>}</button>
      </section>
      {!showResults && !loading && <section className="closet-glance"><div className="section-heading"><div><span className="micro-label">MY CLOSET</span><h3>衣柜里有 32 件衣服</h3></div><button onClick={() => setTab("wardrobe")}>去看看 →</button></div><div className="glance-grid">{garments.slice(0, 4).map(item => <div key={item.id}><GarmentArt color={item.color} /><span>{item.type}</span></div>)}</div></section>}
      {loading && <Thinking />}
      <div className="results-anchor" />
      {showResults && <Results scene={scene} selectedLook={selectedLook} setSelectedLook={setSelectedLook} generateLooks={generateLooks} setShowModel={setShowModel} />}
    </div>
  );

  return (
    <main className={`site-shell ${loading ? "is-thinking" : ""}`}>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={event => handleUpload(event.target.files)} />

      <aside className="desktop-sidebar">
        <button className="side-logo" onClick={() => setTab("home")} aria-label="搭搭首页">搭</button>
        <nav>
          <button className={tab === "home" ? "active" : ""} onClick={() => setTab("home")}><Icon name="home" /><small>今日</small></button>
          <button className={tab === "wardrobe" ? "active" : ""} onClick={() => setTab("wardrobe")}><Icon name="wardrobe" /><small>衣柜</small></button>
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}><Icon name="create" /><small>搭配</small></button>
          <button onClick={() => notify("灵感画廊即将上线")}><Icon name="gallery" /><small>灵感</small></button>
        </nav>
        <div className="sidebar-bottom"><button onClick={() => notify("有问题？告诉搭搭就好")}><Icon name="help" /><small>帮助</small></button><button className="side-avatar" onClick={() => setTab("profile")}>禾</button></div>
      </aside>

      <header className="desktop-topbar">
        <button className="workspace-switch"><span>AI OUTFIT STUDIO</span><b>搭搭 · 阿禾的衣橱</b><i>⌄</i></button>
        <div className="topbar-meta"><span className="weather-pill"><Icon name="sun" /> 杭州 27° · 小雨</span><span>今日 3 / 5 次</span><button onClick={() => setTab("profile")}>个人中心</button></div>
      </header>

      <section className="studio-surface">
        {tab === "home" && (
          <>
            <div className="desktop-home">
              <div className="hero-copy"><span>YOUR CLOSET, REIMAGINED</span><h1>今天，想穿成什么样？</h1><p>说说天气、场合或心情，搭搭只用你衣柜里的单品，给你三个答案。</p></div>
              <section className="studio-composer">
                <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={prompts[promptIndex]} aria-label="描述今天想要的穿搭" />
                <div className="composer-actions"><button className="upload-button" onClick={() => fileRef.current?.click()}><Icon name="camera" /> 添加衣服 <span>⌄</span></button><div><button className="tune-button" onClick={() => notify("已使用你的身材、天气和风格偏好")}><Icon name="tune" /></button><button className="generate-button" onClick={generateLooks} disabled={loading}>{loading ? <><span className="spinner" />搭配中...</> : <><Icon name="spark" /> 生成三套穿搭</>}</button></div></div>
              </section>
              <div className="suggestion-row">{suggestions.map((item, index) => <button key={item} onClick={() => setPrompt(item)}><span>{["🧥", "🌷", "☕", "☔"][index]}</span>{item}</button>)}</div>
              <div className="desktop-scene-row">{scenes.map(item => <button key={item} className={scene === item ? "active" : ""} onClick={() => setScene(item)}>{item}</button>)}</div>

              {loading && <Thinking />}
              <div className="results-anchor" />
              {showResults ? <Results scene={scene} selectedLook={selectedLook} setSelectedLook={setSelectedLook} generateLooks={generateLooks} setShowModel={setShowModel} /> : (
                <section className="shortcut-section">
                  <div className="shortcut-heading"><div><span>STUDIO SHORTCUTS</span><h2>穿搭工作室</h2></div><p>衣柜已有 32 件单品 · 今天还有 3 次生成机会</p></div>
                  <div className="shortcut-grid">
                    <button className="shortcut-card card-today" onClick={generateLooks}><div className="shortcut-art garment-collage">{garments.slice(0, 4).map(item => <GarmentArt key={item.id} color={item.color} />)}</div><span><Icon name="spark" /> 今日穿搭</span><b>让 AI 从你的衣柜里搭出今天</b><small>天气 × 场合 × 你的偏好</small></button>
                    <button className="shortcut-card card-create" onClick={() => setTab("create")}><div className="shortcut-art mini-canvas">{[1, 4, 5].map(id => <GarmentArt key={id} color={garments.find(item => item.id === id)!.color} />)}</div><span>＋ 个人搭配</span><b>你来选，AI 做轻松点评</b><small>颜色、比例、天气与场合</small></button>
                    <button className="shortcut-card card-model" onClick={() => { setSelectedLook(1); setShowModel(true); }}><div className="model-card-image"><i /><em /></div><span>♙ AI 模特</span><b>看看衣服穿上身的样子</b><small>系统模特 · 近似你的体型</small></button>
                    <button className="shortcut-card card-closet" onClick={() => setTab("wardrobe")}><div className="shortcut-art closet-collage">{garments.slice(4, 8).map(item => <GarmentArt key={item.id} color={item.color} />)}</div><span><Icon name="wardrobe" /> 我的衣柜</span><b>拍照上传，AI 自动整理</b><small>去背景 · 分类 · 识别颜色</small></button>
                  </div>
                </section>
              )}
            </div>
            {mobileHome}
          </>
        )}

        {tab === "wardrobe" && <div className="screen wardrobe-screen"><header className="sub-header"><div><span className="micro-label">MY CLOSET</span><h2>我的衣柜 <sup>32</sup></h2></div><button className="round-add" onClick={() => fileRef.current?.click()}>+</button></header><button className="upload-zone" onClick={() => fileRef.current?.click()}><span className="upload-icon"><Icon name="camera" /></span><b>拍一件，收进衣柜</b><small>AI 自动去背景、识别分类和颜色</small></button><div className="filter-row">{filters.map(filter => <button key={filter} className={closetFilter === filter ? "active" : ""} onClick={() => setClosetFilter(filter)}>{filter}</button>)}</div><div className="wardrobe-grid">{uploaded.map((src, index) => <button className="wardrobe-item" key={src}><div className="uploaded-wrap"><img src={src} alt={`新上传衣物 ${index + 1}`} /><span className="ai-tag">AI 已识别</span></div><b>新衣物</b><small>点击确认信息</small></button>)}{filtered.map(item => <button className="wardrobe-item" key={item.id}><div className="wardrobe-art"><GarmentArt color={item.color} /></div><b>{item.name}</b><small>{item.meta}</small></button>)}</div></div>}

        {tab === "create" && <div className="screen create-screen"><header className="sub-header"><div><span className="micro-label">STYLE IT YOURSELF</span><h2>今天你来搭</h2></div><span className="step-chip">已选 {selectedItems.length} 件</span></header><p className="lead-copy">从衣柜挑出你想穿的，AI 只负责说真话和锦上添花。</p><section className="canvas-card"><div className="canvas-label"><span>你的搭配</span><button onClick={() => setSelectedItems([])}>清空</button></div><div className="canvas-items">{selectedItems.length ? selectedItems.map(id => { const item = garments.find(g => g.id === id)!; return <button key={id} onClick={() => setSelectedItems(items => items.filter(value => value !== id))}><GarmentArt color={item.color} /><span>×</span></button>; }) : <p>轻点下面的单品，把它放进来</p>}</div></section><div className="mini-section-title"><b>从衣柜选择</b><span>全部单品</span></div><div className="pick-grid">{garments.map(item => { const active = selectedItems.includes(item.id); return <button key={item.id} className={active ? "active" : ""} onClick={() => setSelectedItems(items => active ? items.filter(id => id !== item.id) : [...items, item.id])}><GarmentArt color={item.color} /><span>{active ? <Icon name="check" /> : "+"}</span></button>; })}</div><button className="review-button" disabled={selectedItems.length < 2} onClick={() => setShowReview(true)}><Icon name="spark" /> 让 AI 看看这套</button></div>}

        {tab === "profile" && <div className="screen profile-screen"><header className="sub-header"><div><span className="micro-label">PROFILE</span><h2>关于阿禾</h2></div><button className="edit-link" onClick={() => notify("个人资料已进入可编辑状态")}>编辑</button></header><section className="profile-hero"><div className="big-avatar">禾</div><div><h3>阿禾</h3><p>穿衣要舒服，也要有一点意思。</p></div></section><section className="body-card"><div><span>身高</span><b>168<small> cm</small></b></div><div><span>体重</span><b>55<small> kg</small></b></div><div><span>身材比例</span><b>直筒型</b></div></section><section className="taste-card"><span className="micro-label">STYLE DNA</span><h3>你的风格偏好</h3><div><i style={{ width: "82%" }} /><span>松弛感</span></div><div><i style={{ width: "70%" }} /><span>简约</span></div><div><i style={{ width: "54%" }} /><span>轻复古</span></div></section><section className="usage-card"><div><span>今日生成额度</span><b>3 / 5</b></div><div className="usage-track"><i /></div><small>每日 00:00 自动恢复</small></section><div className="settings-list"><button>常驻城市 <span>杭州 ›</span></button><button>手机号与微信 <span>已绑定 ›</span></button><button>照片与隐私 <span>›</span></button></div></div>}
      </section>

      <BottomNav tab={tab} setTab={setTab} />

      {showModel && <div className="modal-backdrop" onClick={() => setShowModel(false)}><section className="modal model-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowModel(false)}>×</button><div className="model-visual"><div className="model-silhouette"><span className="model-head" /><span className="model-hair" /><span className="model-top" /><span className="model-leg left" /><span className="model-leg right" /><span className="model-shoe left" /><span className="model-shoe right" /></div><span className="model-badge">近似你的身材比例</span></div><div className="model-copy"><span className="micro-label">AI MODEL PREVIEW</span><h3>这套，穿上比平铺更好看</h3><p>短上衣和高腰阔腿裤把重心提起来了，橄榄绿也很衬你的中性色偏好。小雨天记得带伞，鞋面沾水后及时擦一下。</p><div className="rating-row"><span>颜色协调 <b>96</b></span><span>版型比例 <b>94</b></span><span>场合适配 <b>92</b></span></div><button onClick={() => { setShowModel(false); notify("穿搭已收藏到「我的灵感」"); }}>收藏这套</button></div></section></div>}

      {showReview && <div className="modal-backdrop" onClick={() => setShowReview(false)}><section className="modal review-modal" onClick={event => event.stopPropagation()}><button className="modal-close" onClick={() => setShowReview(false)}>×</button><span className="review-score">88<small>分</small></span><span className="micro-label">AI OUTFIT REVIEW</span><h3>好看，而且挺像你。</h3><p>奶油白和炭灰很稳，焦糖色鞋子刚好把整套提暖了一点。比例也舒服，通勤穿完全没问题。</p><div className="review-notes"><div><b>颜色协调</b><span>柔和耐看，焦糖色是亮点</span></div><div><b>版型比例</b><span>上短下长，很显腿长</span></div><div><b>可以更好</b><span>衣柜里如果添一条细皮带，层次会更完整</span></div></div><button onClick={() => { setShowReview(false); setSelectedLook(1); setShowModel(true); }}>生成 AI 模特效果图</button></section></div>}
      {toast && <div className="toast"><Icon name="check" /> {toast}</div>}
    </main>
  );
}

function Thinking() {
  return <section className="ai-thinking" aria-live="polite"><div className="scan-stage"><span className="scan-ring ring-a" /><span className="scan-ring ring-b" /><div className="scan-clothes">{garments.slice(0, 4).map(item => <GarmentArt key={item.id} color={item.color} mini />)}</div><span className="scan-line" /></div><div className="thinking-copy"><span>AI STYLING IN PROGRESS</span><b>正在理解天气、场合和你</b><i><em /></i></div></section>;
}

function Results({ scene, selectedLook, setSelectedLook, generateLooks, setShowModel }: { scene: Scene; selectedLook: number | null; setSelectedLook: (id: number) => void; generateLooks: () => void; setShowModel: (show: boolean) => void }) {
  return <section className="results-section"><div className="section-heading"><div><span className="micro-label">TODAY&apos;S EDIT</span><h3>{scene}的三种打开方式</h3></div><button onClick={generateLooks}>换一批</button></div><p className="result-context">已结合体感 29°、小雨和你的直筒型身材</p><div className="outfit-list">{looks.map(look => <div className={`outfit-reveal look-${look.id}`} key={look.id}><OutfitCard look={look} active={selectedLook === look.id} onClick={() => setSelectedLook(look.id)} /></div>)}</div><button className="model-button" disabled={!selectedLook} onClick={() => setShowModel(true)}>{selectedLook ? "在 AI 模特上看看效果" : "先选择一套喜欢的穿搭"}</button></section>;
}
