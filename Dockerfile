# 易搭 AI 穿搭助手 · 生产镜像
# 目标运行时：火山引擎 veFaaS「Web 应用函数」（容器镜像部署）
# 监听 0.0.0.0:8000（veFaaS 默认端口，避开 9000/9001/9990）

# ---- 依赖安装（含 dev，供构建阶段使用）----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- 构建 ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 运行（standalone 产物）----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=8000

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public

# Next.js standalone 输出
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 8000

# veFaaS 未指定启动命令时默认执行 /opt/application/run.sh；
# 这里用 CMD 显式声明入口，控制台里也可自定义启动命令覆盖。
CMD ["node", "server.js"]
