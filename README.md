# 易搭 · AI 穿搭助手

易搭是一款面向手机 H5 的个人 AI 衣柜与穿搭助手。当前已完成第一阶段：从用户照片中识别衣物、鞋履、帽子、腰带、包和首饰等单品，生成高清白底商品图，补充适合后续 AI 穿搭的结构化标签，并保存到个人衣柜。

## 第一阶段已实现

- 手机拍照或从相册一次上传 1–5 张图片
- 一张图片中识别多件独立单品，并输出类别、颜色和位置
- 针对容易漏检的鞋履、帽子和腰带进行补充识别
- 对同一双鞋、重叠框和跨任务旧结果进行去重与隔离
- 逐件裁剪后生成 1536×1536 高清白底商品图
- 对商品图进行质量检查，疑似混入人体或其他衣物时提示人工确认
- 自动生成适合穿搭推荐的标签，包括具体品类、材质、图案、版型、长度、色调、层级、保暖度、正式度、风格、场合、季节和天气
- 用户可点击整张卡片切换是否入柜，并可修改名称、分类和季节
- MySQL 保存衣柜信息，TOS 保存原图和商品图
- 衣柜支持分类浏览、编辑、标记清洗和即时删除

## 当前处理链路

1. `Qwen3-VL-Flash` 识别图片内的独立穿戴单品，返回类别、颜色、二维框及建议处理方式。
2. 浏览器 Canvas 按二维框逐件裁剪，减少无关人物和背景信息。
3. `Qwen-Image 2.0` 根据裁剪图重建高清纯白背景商品主图。
4. `Qwen3-VL-Flash` 对生成结果做质量复核，并生成结构化穿搭标签。
5. 用户确认后，服务端将元数据写入火山引擎 MySQL，将图片写入 TOS。

项目中还保留了阿里云视觉智能开放平台的 `SegmentCloth`、`SegmentCommodity` 和 `RefineMask` 接入代码，作为传统分割与边缘优化的备用能力；当前主流程以百炼视觉理解和商品图生成为主。

## 技术栈

- React 19、TypeScript、Tailwind CSS
- Next.js（App Router，standalone 输出）
- 火山引擎 veFaaS「Web 应用函数」（容器镜像部署）
- 火山引擎云数据库 MySQL（`mysql2`）
- 火山引擎 TOS 对象存储（`@aws-sdk/client-s3`，S3 兼容）
- 阿里云百炼 `Qwen3-VL-Flash`、`Qwen-Image 2.0`
- 阿里云视觉智能开放平台分割接口（备用）

## 本地启动

环境要求：Node.js `>=22.13.0`，本地或远程可用的 MySQL 实例与 TOS（或 MinIO 等 S3 兼容存储）。

```bash
npm install
cp .env.example .env.local
# 在 .env.local 中填写 DASHSCOPE_*、MYSQL_*、TOS_* 等密钥
npm run dev
```

随后打开终端提示的本地地址。`.env.local` 已被 Git 忽略，不会包含在源码包中。

## 验证与构建

```bash
npm run typecheck   # TypeScript 类型检查
npm test            # 迁移与业务逻辑断言测试
npm run lint        # ESLint
npm run build       # Next.js 生产构建（standalone 产物）
```

- `npm run dev`：启动本地开发环境
- `npm run build`：生成 Next.js standalone 构建产物
- `npm run db:init`：连接 MySQL 执行 `db/mysql/0000_init.sql` 初始化表结构

## 主要目录

- `app/page.tsx`：主界面与衣柜上传交互
- `app/api/wardrobe/analyze/route.ts`：多单品识别、定位和去重
- `app/api/wardrobe/productize/route.ts`：高清商品图、质量复核和标签生成
- `app/api/wardrobe/cutout/route.ts`：阿里云传统分割备用接口
- `app/api/wardrobe/route.ts`：衣柜读写、编辑和删除
- `app/api/outfits/`：穿搭推荐与试穿效果图
- `app/api/model-profile/route.ts`：个人模特全身照
- `app/lib/db.ts`：MySQL 连接池与建表
- `app/lib/storage.ts`：TOS 对象存储封装
- `app/lib/garment-image.ts`：浏览器裁剪及图像处理
- `app/lib/garment-tags.ts`：穿搭标签规范化与传输
- `db/mysql/0000_init.sql`：MySQL 表结构初始化脚本
- `Dockerfile`：生产镜像构建
- `tests/`：自动化测试

## 部署到火山引擎 veFaaS

### 0. 开通服务

1. 注册火山引擎账号并完成实名认证。
2. 开通「函数服务 veFaaS」并完成跨服务授权（子账号需 `veFaaSFullAccess`）。
3. 开通「TOS 对象存储」，创建 Bucket（如 `yida-wardrobe`）。
4. 开通「云数据库 MySQL」，创建实例、数据库 `yida` 与账号，**与 veFaaS 函数同地域、同 VPC**。
5. 开通「容器镜像服务」，创建命名空间与镜像仓库。
6. 生成火山引擎 AccessKey（AK/SK）。

### 1. 初始化数据库

在能连通 MySQL 的环境执行（`db/mysql/0000_init.sql`）：

```bash
MYSQL_HOST=... MYSQL_USER=... MYSQL_PASSWORD=... MYSQL_DATABASE=yida npm run db:init
```

（应用启动时也会惰性创建同样的表结构，此步骤可作兜底。）

### 2. 构建并推送镜像

```bash
docker build -t <镜像仓库地址>:latest .
docker push <镜像仓库地址>:latest
```

### 3. 创建 veFaaS Web 应用函数

在函数服务控制台创建「Web 应用函数」：

- 部署方式 = 镜像，选择已推送的镜像；
- Webserver 模式 = 是，监听端口 = `8000`；
- 绑定与 MySQL 相同的 VPC / 子网 / 安全组；
- 配置环境变量（`MYSQL_*`、`TOS_*`、`DASHSCOPE_*`、`ALIBABA_CLOUD_*`）；
- 设置实例规格与实例数下限（预留实例降低冷启动）；
- 创建 HTTP 触发器，获取默认公网访问域名。

### 4. 绑定自定义域名（可选）

购买域名并完成 ICP 备案后，将域名解析/CNAME 到 veFaaS 提供的访问地址，并在控制台绑定。

## GitHub 上传

```bash
git init
git add .
git commit -m "Initial import of 易搭 AI 穿搭助手"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

上传前请再次确认仓库中不存在 `.env.local`、真实 AccessKey、API Key 或其他账号凭据。线上密钥统一在 veFaaS 函数的环境变量中配置。

## 当前阶段说明

第一阶段的核心目标是建立可靠的「照片 → 独立商品图 → 标签 → 入柜」数据底座。AI 三套穿搭推荐、天气与场合推荐、模特试穿和用户搭配评价属于后续阶段。
