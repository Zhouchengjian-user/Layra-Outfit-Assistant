import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const sentryDsn = process.env.SENTRY_DSN?.trim() || "";

const nextConfig: NextConfig = {
  // standalone 输出，配合 Dockerfile 与 veFaaS 容器镜像部署。
  output: "standalone",
  // 衣柜图片均为动态 URL（TOS/接口相对路径），关闭内置图片优化。
  images: { unoptimized: true },
  // Sentry DSN 是公开接收端标识；仅在构建时配置后注入浏览器端。
  ...(sentryDsn ? { env: { NEXT_PUBLIC_SENTRY_DSN: sentryDsn } } : {}),
};

export default sentryDsn
  ? withSentryConfig(nextConfig, {
      silent: true,
      telemetry: false,
      sourcemaps: { disable: true },
      routeManifestInjection: false,
    })
  : nextConfig;
