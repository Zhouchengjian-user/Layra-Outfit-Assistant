import type { Metadata } from "next";
import Link from "next/link";
import { LayraMark, type LayraMarkVariant } from "../components/layra-mark";
import styles from "./brand.module.css";

export const metadata: Metadata = {
  title: "LAYRA · Logo 方向",
  description: "LAYRA 品牌标志候选方案",
};

const concepts: Array<{ id: string; variant: LayraMarkVariant; name: string; meaning: string; note: string }> = [
  { id: "A", variant: "loop", name: "The Thread", meaning: "一根线从 L 延伸成穿搭轨迹，代表衣柜中的单品被重新连接。", note: "轻盈、灵动，最适合 AI 穿搭助手。" },
  { id: "B", variant: "fold", name: "The Fold", meaning: "L 与 A 折叠成衣架和衣领的几何轮廓，强调服装属性。", note: "识别直接，时装感更强。" },
  { id: "C", variant: "stitch", name: "The Stitch", meaning: "断续针脚连接 L 与 A，表达搭配、整理与持续学习。", note: "细腻、编辑感，适合偏女性化的品牌气质。" },
  { id: "D", variant: "frame", name: "The Frame", meaning: "圆角框包住 LA 字母结构，像一面衣橱镜，也像 App 图标。", note: "稳重、清晰，小尺寸表现最好。" },
];

export default function BrandPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" className={styles.back}>← 返回产品</Link>
      <span>LAYRA / IDENTITY STUDY</span>
    </header>
    <section className={styles.intro}>
      <div><p>四个方向，一个名字</p><h1>为 LAYRA 选择<br />第一张脸。</h1></div>
      <p>四版都使用单色矢量结构，可直接用于网页、App 图标和启动页。先看图形气质，颜色和细节会在选定方向后继续精修。</p>
    </section>
    <section className={styles.grid} aria-label="LAYRA Logo 候选方案">
      {concepts.map((concept, index) => <article className={`${styles.card} ${concept.id === "D" ? styles.chosen : ""}`} key={concept.id}>
        <div className={styles.preview}>
          <span className={styles.index}>{concept.id}</span>
          {concept.id === "D" && <span className={styles.selected}>已选用</span>}
          <LayraMark variant={concept.variant} className={styles.mark} />
          <strong>LAYRA</strong>
          <small>AI OUTFIT STUDIO</small>
        </div>
        <div className={styles.detail}>
          <div><span>0{index + 1}</span><h2>{concept.name}</h2></div>
          <p>{concept.meaning}</p>
          <b>{concept.note}</b>
        </div>
      </article>)}
    </section>
    <footer className={styles.footer}><span>告诉我 A、B、C 或 D</span><p>选定后我会继续调整线条、比例、图标底色与最终应用尺寸。</p></footer>
  </main>;
}
