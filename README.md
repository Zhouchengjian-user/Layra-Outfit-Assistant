# 易搭 · AI 穿搭助手

易搭是一款面向手机 H5 的个人 AI 衣柜与穿搭助手。当前已完成第一阶段：从用户照片中识别衣物、鞋履、帽子、腰带、包和首饰等单品，生成高清白底商品图，补充适合后续 AI 穿搭的结构化标签，并保存到个人衣柜。

当前在线演示：<https://dada-ai-outfit.chengjain.chatgpt.site>

## 第一阶段已实现

- 手机拍照或从相册一次上传 1–5 张图片
- 一张图片中识别多件独立单品，并输出类别、颜色和位置
- 针对容易漏检的鞋履、帽子和腰带进行补充识别
- 对同一双鞋、重叠框和跨任务旧结果进行去重与隔离
- 逐件裁剪后生成 1536×1536 高清白底商品图
- 对商品图进行质量检查，疑似混入人体或其他衣物时提示人工确认
- 自动生成适合穿搭推荐的标签，包括具体品类、材质、图案、版型、长度、色调、层级、保暖度、正式度、风格、场合、季节和天气
- 用户可点击整张卡片切换是否入柜，并可修改名称、分类和季节
- D1 保存衣柜信息，R2 保存原图和商品图
- 衣柜支持分类浏览、编辑、标记清洗和即时删除

## 当前处理链路

1. `Qwen3-VL-Flash` 识别图片内的独立穿戴单品，返回类别、颜色、二维框及建议处理方式。
2. 浏览器 Canvas 按二维框逐件裁剪，减少无关人物和背景信息。
3. `Qwen-Image 2.0` 根据裁剪图重建高清纯白背景商品主图。
4. `Qwen3-VL-Flash` 对生成结果做质量复核，并生成结构化穿搭标签。
5. 用户确认后，服务端将元数据写入 Cloudflare D1，将图片写入 R2。

项目中还保留了阿里云视觉智能开放平台的 `SegmentCloth`、`SegmentCommodity` 和 `RefineMask` 接入代码，作为传统分割与边缘优化的备用能力；当前主流程以百炼视觉理解和商品图生成为主。

## 技术栈

- React 19、TypeScript、Tailwind CSS
- vinext、Vite、Cloudflare Workers
- Cloudflare D1、R2
- Drizzle ORM
- 阿里云百炼 `Qwen3-VL-Flash`、`Qwen-Image 2.0`
- 阿里云视觉智能开放平台分割接口（备用）

## 本地启动

环境要求：Node.js `>=22.13.0`。

```bash
npm install
cp .env.example .env.local
npm run dev
```

随后打开终端提示的本地地址。请在 `.env.local` 中填写自己的密钥；该文件已被 Git 忽略，不会包含在源码包中。

## 验证与构建

```bash
npm run lint
npm test
npm run build
```

- `npm run dev`：启动本地开发环境
- `npm run build`：生成 vinext / Cloudflare 构建产物
- `npm test`：构建并执行页面渲染测试
- `npm run db:generate`：修改数据库结构后生成 Drizzle 迁移

## 主要目录

- `app/page.tsx`：主界面与衣柜上传交互
- `app/api/wardrobe/analyze/route.ts`：多单品识别、定位和去重
- `app/api/wardrobe/productize/route.ts`：高清商品图、质量复核和标签生成
- `app/api/wardrobe/cutout/route.ts`：阿里云传统分割备用接口
- `app/api/wardrobe/route.ts`：衣柜读写、编辑和删除
- `app/lib/garment-image.ts`：浏览器裁剪及图像处理
- `app/lib/garment-tags.ts`：穿搭标签规范化与传输
- `db/schema.ts`：D1 数据结构
- `drizzle/`：数据库迁移
- `tests/`：自动化测试
- `.openai/hosting.json`：Sites 的 D1 与 R2 绑定

## GitHub 上传

解压源码包后，在项目目录执行：

```bash
git init
git add .
git commit -m "Initial import of 易搭 AI 穿搭助手"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

上传前请再次确认仓库中不存在 `.env.local`、真实 AccessKey、API Key 或其他账号凭据。线上部署时应在托管平台的环境变量或 Secrets 中配置密钥。

## 当前阶段说明

第一阶段的核心目标是建立可靠的“照片 → 独立商品图 → 标签 → 入柜”数据底座。AI 三套穿搭推荐、天气与场合推荐、模特试穿和用户搭配评价属于后续阶段。
