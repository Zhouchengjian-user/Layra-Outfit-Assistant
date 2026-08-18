import { env } from "cloudflare:workers";

export function getServerEnv(name: string) {
  const workerValue = (env as Record<string, unknown>)[name];
  if (typeof workerValue === "string" && workerValue.trim()) return workerValue.trim();
  const nodeValue = process.env[name];
  return typeof nodeValue === "string" ? nodeValue.trim() : "";
}

export function requireServerEnv(name: string) {
  const value = getServerEnv(name);
  if (!value) throw new Error(`服务端缺少 ${name} 配置`);
  return value;
}
