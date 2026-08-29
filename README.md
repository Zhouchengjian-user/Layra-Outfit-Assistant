# 易搭 · AI 穿搭助手

易搭是一款面向手机 H5 的个人 AI 衣柜与穿搭助手。用户可以从照片中识别单品、生成白底商品图、维护个人衣柜，并获得穿搭推荐和试穿效果图。

## 当前能力

- 一次上传 1–5 张照片，识别衣物、鞋履、帽子、腰带、包和首饰等单品
- 按识别框逐件裁剪，生成 1536×1536 白底商品图并补充结构化穿搭标签
- 衣柜分类浏览、编辑、清洗状态、删除和多用户数据隔离
- AI 穿搭推荐、历史记录、收藏搭配和模特试穿
- 邀请码登录，服务端签名会话 Cookie，有效期 7 天
- TOS 保存图片；轻量生产模式使用 SQLite + TOS 快照恢复

## 技术与运行方式

- React 19、TypeScript、Tailwind CSS、Next.js App Router
- Next.js `standalone` 生产产物，入口为 `node server.js`
- 容器监听 `0.0.0.0:8000`
- 生产镜像目标平台为 `linux/amd64`
- 火山引擎 veFaaS Web 应用函数、TOS、Serverless API 网关
- 阿里云百炼 `Qwen3-VL-Flash`、`Qwen-Image 2.0`
- 火山方舟图像模型用于试穿效果图

## 本地开发

要求 Node.js `>=22.16.0`。项目默认使用本地 SQLite 和本地对象目录，不要求先准备云数据库。

```bash
npm install
cp .env.example .env.local
npm run dev
```

本地数据位于 `.data/`。`.env.local` 已被 Git 和镜像构建忽略，禁止提交任何邀请码、AccessKey 或模型 Key。

提交或部署前运行：

```bash
npm run typecheck
npm test
npm run lint
npm run build
```

## 生产架构约束

当前线上采用早期轻量方案：一个常驻 veFaaS 实例、`/tmp` SQLite、TOS 固定键快照。以下约束是数据安全的一部分，不能单独放宽。

- SQLite 只允许写入 `/tmp/data/yida.sqlite`；容器内 `.data/` 仅供本地开发。
- veFaaS 实例数必须同时设置为 `min=1`、`max=1`。
- 所有发布和回滚必须全量切换到单一版本，禁止灰度、流量拆分或多版本并行。
- veFaaS 的整个 `/tmp` 空间上限为 512 MB，数据库、WAL、临时快照会共同占用它。数据库接近 200 MB 时就应安排迁移 MySQL，不能等到 512 MB 才处理。
- 数据库快照固定保存为 TOS 对象 `db_backup/yida.sqlite`，不要改成按实例或版本分叉的键。
- 默认写入后约 10 秒触发防抖备份，并每 5 分钟补偿检查；灾难恢复目标 RPO 约 5 分钟，不是零数据丢失保证。
- 新实例本地数据库不存在时，会从固定 TOS 键下载、校验并原子恢复；运行中快照使用 SQLite backup API，禁止直接复制 WAL 数据库文件。

`min=max=1` 既让 `/tmp` 所在实例常驻，也避免两个 SQLite 副本同时接受写入。实例故障、全量发布或平台迁移仍可能重建实例，因此 TOS 快照不可省略。

## 生产环境变量

真实值只配置在 veFaaS，不写入仓库、镜像、日志或聊天记录。

```dotenv
ENV=prod
INVITE_CODES=<逗号分隔的高熵邀请码，每个至少 12 个字符>
SESSION_SECRET=<至少 32 个字符的随机密钥>
OWNER_ID_SECRET=<另一份至少 32 个字符的随机密钥>

DASHSCOPE_API_KEY=<secret>
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
DASHSCOPE_VISION_MODEL=qwen3-vl-flash
DASHSCOPE_IMAGE_ENDPOINT=https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
DASHSCOPE_PRODUCT_IMAGE_MODEL=qwen-image-2.0
DASHSCOPE_PRODUCT_IMAGE_SIZE=1536*1536
DASHSCOPE_GARMENT_RECONSTRUCTION_MODEL=qwen-image-2.0
DASHSCOPE_GARMENT_RECONSTRUCTION_SIZE=1024*1024
DASHSCOPE_GARMENT_RECONSTRUCTION_CANDIDATES=2

ARK_API_KEY=<secret>
# 可选：只有填写当前账号已开通的视觉模型或推理接入点 ID 时，才启用识别降级。
ARK_VISION_MODEL=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_IMAGE_MODEL=doubao-seedream-5-0-lite-260128
ARK_IMAGE_SIZE=1920x1920
# 可选：百炼生成服务欠费或鉴权失败时，商品图自动切换到这组 Seedream 配置。
ARK_GARMENT_RECONSTRUCTION_MODEL=
ARK_GARMENT_RECONSTRUCTION_SIZE=
ARK_GARMENT_RECONSTRUCTION_CANDIDATES=2

SQLITE_PATH=/tmp/data/yida.sqlite
SQLITE_BACKUP_INTERVAL_MS=300000
SQLITE_BACKUP_DEBOUNCE_MS=10000

TOS_REGION=cn-beijing
TOS_ENDPOINT=https://tos-s3-cn-beijing.volces.com
TOS_BUCKET=<bucket-name>
```

生产轻量模式不要配置 `MYSQL_HOST`，否则应用会切换到 MySQL。生产环境也不要配置 `TOS_ACCESS_KEY_ID`、`TOS_ACCESS_KEY_SECRET` 或其他长期 TOS AK/SK。

认证配置注意事项：

- `SESSION_SECRET` 与 `OWNER_ID_SECRET` 必须不同。
- 邀请码会稳定映射为用户 ID，所有数据查询均按该 ID 隔离。
- 轮换 `SESSION_SECRET` 会让全部用户退出登录。
- 轮换 `OWNER_ID_SECRET` 或替换已使用的邀请码会改变用户 ID，使原衣柜看起来“消失”。上线后不要随意轮换；确需轮换时先做数据迁移。
- 生产缺少或误配任一认证变量时，接口会拒绝服务，不能降级成匿名访问。

## 既有本地数据迁移

上线前若 `.data/yida.sqlite` 已有旧匿名用户数据，禁止直接覆盖源库或把整个 `.data` 打进镜像。先确认要保留的旧 owner，再把它映射到邀请码对应的稳定 `usr-...` 用户 ID：

```bash
npm run migration:prepare -- \
  --source-db .data/yida.sqlite \
  --objects-dir .data/objects \
  --source-owner <确认保留的旧 owner> \
  --target-owner <邀请码对应的 usr-... ID> \
  --output /tmp/yida-production-migration.sqlite
```

只有在已经人工确认“衣柜最多的 owner 就是主数据”时，才可用 `--source largest` 代替 `--source-owner`。脚本只读源库，拒绝覆盖现有输出，校验 SQLite、收藏引用与所有图片，并只输出记录数和字节数；生成文件权限为 `0600`。

将生成文件作为单个私有对象上传到 `db_backup/yida.sqlite` 后，新实例会先恢复数据库，再用当前请求的 veFaaS Role STS 幂等写入内嵌图片。任一图片失败会保留迁移载荷供下次重试；全部成功才删除临时表并写回正常轻量快照。验证 TOS 图片、固定快照和公网读取均正常后，立即删除本地 `/tmp` 迁移文件，绝不能提交到 Git 或放进镜像。

## TOS 与 veFaaS Role

生产函数通过绑定 veFaaS IAM Role 访问 TOS。Role 只授予目标 Bucket 及业务图片、`db_backup/yida.sqlite` 所需的最小对象读写权限。

veFaaS Web 应用会把短期 STS 凭据按请求注入 `x-faas-access-key-id`、`x-faas-secret-access-key`、`x-faas-session-token`。应用为每次存储操作创建 TOS 客户端并携带 Session Token，不写盘、不记录，也不做长期客户端缓存；后台待写快照只在内存中暂存最近一次短期凭据，成功后立即释放。绑定 Role 后必须重新全量发布函数，权限才会进入新版本。

```bash
vefaas fn config --id <FUNCTION_ID> \
  --role 'trn:iam::<ACCOUNT_ID>:role/<ROLE_NAME>' \
  --region cn-beijing

vefaas fn release --id <FUNCTION_ID> \
  --description 'bind least-privilege TOS role' \
  --region cn-beijing
```

## 构建与发布

### 1. 构建不可变镜像

使用提交号或版本号作为标签，不要用会漂移的 `latest` 作为回滚依据。

```bash
docker buildx build \
  --platform linux/amd64 \
  -t <registry>/<namespace>/yida-ai-outfit:<version> \
  --push .
```

### 2. 配置 veFaaS Web 应用函数

- 运行类型：Web 应用函数，镜像部署
- 启动命令：`node server.js`
- 监听端口：`8000`
- 当前规格：1 vCPU / 2 GiB
- 请求超时：按最长 AI 链路配置，函数上限 900 秒
- 公网出方向：开启，用于访问模型服务
- 环境变量：先配置完整，再发布
- IAM Role：绑定最小权限 TOS Role

首次发布成功后再设置实例上下限：

```bash
vefaas fn scale --id <FUNCTION_ID> --min 1 --max 1 --region cn-beijing -o json
```

该命令会直接开始预留实例计费，CLI 不会再次弹出费用确认。执行前必须获得资源所有者明确同意。随后确认：

```bash
vefaas fn scale --id <FUNCTION_ID> --region cn-beijing -o json
vefaas fn release-record status --id <FUNCTION_ID> --region cn-beijing -o json
```

每次新镜像都执行一次全量发布，并确认新 revision 获得 100% 流量。禁止为 SQLite 版本设置灰度比例。

### 3. 创建 Serverless API 网关

在华北 2（北京）创建公网 Serverless API 网关。veFaaS CLI 可以给已有网关创建服务、函数 Upstream 和路由，但网关实例本身建议在控制台确认价格后创建。

根路由需要覆盖 Next.js 页面、静态资源和 API：

```bash
vefaas trigger apig bind \
  --id <FUNCTION_ID> \
  --gateway-id <GATEWAY_ID> \
  --service-name yida-ai-outfit \
  --name yida-ai-outfit \
  --route-name yida-ai-outfit \
  --path / \
  --methods GET,POST,PUT,DELETE,HEAD,OPTIONS \
  --region cn-beijing \
  -o json
```

该命令创建的网关服务默认不启用 APIG 认证，公网安全依赖应用的邀请码登录。登录功能未通过冒烟测试前，不要对外分发地址。

## 费用概览

所有金额以创建资源时控制台报价和实际账单为准。

- veFaaS：当前 1 vCPU / 2 GiB 普通预留实例约 `0.21924 元/小时`，约 `157.85 元/30 天`；另计调用次数和函数公网出流量。
- Serverless API 网关：网关管理费为 0；北京固定 CLB 约 `0.0088 元/小时`，约 `6.34 元/30 天`，另计公网流量。
- TOS：对象容量、请求次数和出网流量计费。
- 模型服务：视觉理解、商品图和试穿图按各模型服务规则计费。

按当前规格估算，函数预留实例与网关固定入口合计约 `164.19 元/30 天`，不含 TOS、模型调用、函数调用次数和公网流量。以控制台创建页和实际账单为准。

## 日志与错误监控

- 每个受保护 API 都会生成或安全透传 trace ID，响应头为 `X-Trace-Id`；结构化日志只记录路径、状态、耗时和错误类型，不记录邀请码、Cookie、请求正文、模型输入或密钥。
- `SENTRY_DSN` 留空时不会初始化或发送任何数据；在 veFaaS 运行时配置后启用服务端异常上报。
- 如需浏览器端异常上报，必须在构建镜像前提供同一 DSN。DSN 是公开接收端标识，但仍不得把组织配置或上传令牌写入仓库。
- Sentry 默认关闭 PII、Cookie、Header、Body、查询参数、AI 输入输出、数据库参数、源码上下文、日志和面包屑采集；性能链路采样 1%，错误事件完整采集。

创建 Serverless 网关、设置 `min=1` 或新增任何付费资源前，必须先向资源所有者说明费用并获得确认。

## 上线冒烟测试

每次发布或回滚后至少完成以下检查：

1. 公网 HTTPS 地址可打开，首页和静态资源正常。
2. 未登录访问受保护 API 返回 401；不会返回堆栈、密钥或内部路径。
3. 错误邀请码被拒绝；正确邀请码可以登录、刷新页面后会话仍有效。
4. 用两个不同邀请码分别登录，确认互相看不到衣柜、模特、历史和收藏数据。
5. 上传一件单品，完成识别、商品图生成和入柜；刷新页面后记录和图片仍可读取。
6. 在 TOS 确认图片对象和 `db_backup/yida.sqlite` 已更新。等待一个备份周期后复查固定键更新时间。
7. 检查 veFaaS 日志有 trace ID，且没有邀请码、会话 Token、STS 或模型 Key。
8. 在预发布环境做一次实例重建演练，确认本地库缺失时能从 TOS 自动恢复。

常用只读命令：

```bash
vefaas fn trigger list --id <FUNCTION_ID> --region cn-beijing -o json
vefaas fn release-record status --id <FUNCTION_ID> --region cn-beijing -o json
vefaas fn logs --id <FUNCTION_ID> --region cn-beijing --lines 100
```

## 回滚与恢复

代码回滚不会自动回滚数据库。表结构变更必须向后兼容，发布前应暂停写入至少一个备份周期，并确认 TOS 固定键已更新。

```bash
vefaas fn release-record list --id <FUNCTION_ID> --region cn-beijing -o table
vefaas fn rollback <REVISION> --id <FUNCTION_ID> --region cn-beijing
vefaas fn release-record status --id <FUNCTION_ID> --region cn-beijing -o json
```

回滚后必须确认旧 revision 获得 100% 流量、实例仍为 `min=max=1`，然后重跑登录、数据隔离、图片读写和 SQLite 恢复冒烟测试。若需要恢复业务数据，应使用经过校验的 TOS 数据库快照；不要把运行中的 `yida.sqlite-wal` 或 `yida.sqlite-shm` 当作独立备份。

## MySQL 扩展路线

SQLite 方案只适合早期单实例、低并发阶段。出现以下任一情况就应迁移火山引擎 MySQL：需要多实例扩容、需要灰度发布、并发写入增加、数据库接近 200 MB、要求更小 RPO 或更高可用。

迁移后配置 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE`，将函数接入同地域 VPC，并使用 `db/mysql/0000_init.sql` 初始化结构。迁移验收通过前保留 SQLite/TOS 快照；切换完成后才允许提升 `max` 或启用灰度。

## 主要目录

- `app/api/auth/`：邀请码登录、登出与会话检查
- `app/api/wardrobe/`：衣柜识别、商品图和数据接口
- `app/api/outfits/`：穿搭推荐、历史、收藏与试穿
- `app/lib/auth.ts`：会话签名和稳定用户 ID
- `app/lib/db.ts`：SQLite / MySQL 双模式数据库访问层
- `app/lib/sqlite-persistence.ts`：TOS 快照、校验和自动恢复
- `app/lib/storage.ts`：本地文件 / TOS 双模式对象存储
- `app/lib/storage-request-context.ts`：veFaaS 请求级 STS 上下文
- `db/mysql/0000_init.sql`：后续 MySQL 迁移表结构
- `Dockerfile`：`linux/amd64` standalone 生产镜像
- `tests/`：认证、持久化、存储上下文和业务回归测试
## ComfyUI 衣物抠图

项目支持把单件衣物抠图切换到 ComfyUI 官方 BiRefNet 工作流，并在服务不可用或蒙版质量不合格时回退云端。配置和工作流文件见 [`workflows/comfyui/README.md`](workflows/comfyui/README.md)。配置完成后仍从“我的衣柜”上传照片测试，衣物卡会显示实际抠图引擎。
