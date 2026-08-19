export function getServerEnv(name: string) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export function requireServerEnv(name: string) {
  const value = getServerEnv(name);
  if (!value) throw new Error(`服务端缺少 ${name} 配置`);
  return value;
}
