import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const AGENT_TRANSACTION_COOKIE = "yida_agent_login";
const TRANSACTION_TTL_SECONDS = 10 * 60;

type AgentConfig = { issuer: string; clientId: string; clientSecret: string; redirectUri: string };
type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  id_token_signing_alg_values_supported?: string[];
};
type Transaction = { state: string; nonce: string; verifier: string; exp: number };

function configured(name: string) {
  const value = process.env[name]?.trim() || "";
  return value.startsWith("replace_with_") ? "" : value;
}

function secureUrl(value: string, allowLocalhost = false) {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(allowLocalhost && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("Agent Identity URL 必须使用 HTTPS");
  }
  if (url.username || url.password || url.hash) throw new Error("Agent Identity URL 无效");
  return url;
}

export function isAgentIdentityAvailable() {
  return Boolean(configured("AGENT_IDENTITY_ISSUER") && configured("AGENT_IDENTITY_CLIENT_ID") && configured("AGENT_IDENTITY_CLIENT_SECRET") && configured("AGENT_IDENTITY_REDIRECT_URI"));
}

export function agentIdentityConfig(): AgentConfig {
  if (!isAgentIdentityAvailable()) throw new Error("Agent Identity 尚未配置");
  const issuer = configured("AGENT_IDENTITY_ISSUER");
  const redirectUri = configured("AGENT_IDENTITY_REDIRECT_URI");
  const issuerUrl = secureUrl(issuer, process.env.NODE_ENV !== "production");
  const callbackUrl = secureUrl(redirectUri, process.env.NODE_ENV !== "production");
  if (issuerUrl.search || callbackUrl.search || callbackUrl.pathname !== "/api/auth/agent/callback") throw new Error("Agent Identity 回调地址无效");
  return { issuer, clientId: configured("AGENT_IDENTITY_CLIENT_ID"), clientSecret: configured("AGENT_IDENTITY_CLIENT_SECRET"), redirectUri };
}

export function agentAppHome(requestUrl: string) {
  try { return new URL("/", agentIdentityConfig().redirectUri); }
  catch { return new URL("/", requestUrl); }
}

export async function agentIdentityDiscovery(config: AgentConfig): Promise<Discovery> {
  const response = await fetch(`${config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("无法读取 Agent Identity OIDC 配置");
  const document = await response.json() as Partial<Discovery>;
  if (document.issuer !== config.issuer) throw new Error("Agent Identity issuer 不匹配");
  for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    if (typeof document[key] !== "string") throw new Error("Agent Identity OIDC 配置不完整");
    secureUrl(document[key], process.env.NODE_ENV !== "production");
  }
  return document as Discovery;
}

function transactionSecret() {
  const secret = configured("SESSION_SECRET");
  if (secret.length < 32) throw new Error("登录服务尚未配置");
  return secret;
}

export function newAgentTransaction(now = Date.now()): Transaction {
  const random = () => randomBytes(32).toString("base64url");
  return { state: random(), nonce: random(), verifier: random(), exp: Math.floor(now / 1000) + TRANSACTION_TTL_SECONDS };
}

export function sealAgentTransaction(transaction: Transaction) {
  const body = Buffer.from(JSON.stringify(transaction)).toString("base64url");
  const signature = createHmac("sha256", transactionSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function readAgentTransaction(cookie: string, state: string, now = Date.now()): Transaction | null {
  const [body, signature, extra] = cookie.split(".");
  if (!body || !signature || extra || cookie.length > 4096 || !state) return null;
  const expected = createHmac("sha256", transactionSecret()).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, "base64url"); } catch { return null; }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString()) as Partial<Transaction>;
    if (typeof value.state !== "string" || value.state !== state || typeof value.nonce !== "string" || typeof value.verifier !== "string") return null;
    if (!Number.isInteger(value.exp) || (value.exp as number) < Math.floor(now / 1000) || (value.exp as number) > Math.floor(now / 1000) + TRANSACTION_TTL_SECONDS) return null;
    return value as Transaction;
  } catch { return null; }
}

export function agentAuthorizeUrl(config: AgentConfig, discovery: Discovery, transaction: Transaction) {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", transaction.state);
  url.searchParams.set("nonce", transaction.nonce);
  url.searchParams.set("code_challenge", createHash("sha256").update(transaction.verifier).digest("base64url"));
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

export async function exchangeAgentCode(config: AgentConfig, discovery: Discovery, code: string, transaction: Transaction) {
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: transaction.verifier });
  const response = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` },
    body: form,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Agent Identity 授权码交换失败");
  const token = await response.json() as { id_token?: unknown };
  if (typeof token.id_token !== "string" || token.id_token.length > 20_000) throw new Error("Agent Identity ID Token 无效");
  const allowedAlgorithms = ["RS256", "PS256", "ES256"].filter(algorithm => !discovery.id_token_signing_alg_values_supported || discovery.id_token_signing_alg_values_supported.includes(algorithm));
  if (!allowedAlgorithms.length) throw new Error("Agent Identity 签名算法不受支持");
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: 10_000 });
  const { payload } = await jwtVerify(token.id_token, jwks, { issuer: config.issuer, audience: config.clientId, algorithms: allowedAlgorithms, requiredClaims: ["sub", "nonce", "exp", "iat"] });
  if (payload.nonce !== transaction.nonce || typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 2048) throw new Error("Agent Identity 登录状态不匹配");
  return payload.sub;
}

export function agentTransactionCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production" || process.env.ENV?.toLowerCase() === "prod", sameSite: "lax" as const, path: "/api/auth/agent", maxAge: TRANSACTION_TTL_SECONDS };
}
