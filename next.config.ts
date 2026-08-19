import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 输出，配合 Dockerfile 与 veFaaS 容器镜像部署。
  output: "standalone",
  // 衣柜图片均为动态 URL（TOS/接口相对路径），关闭内置图片优化。
  images: { unoptimized: true },
};

export default nextConfig;
