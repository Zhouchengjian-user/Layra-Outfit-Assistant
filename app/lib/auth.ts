import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "yida_session";
export const LEGACY_OWNER_COOKIE_NAME = "yida_owner";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const TOKEN_VERSION = "v1";
const USER_ID_PATTERN = /^usr-[a-f0-9]{40}$/;

type SessionPayload = {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
};

export type AuthSession = {
  userId: string;
  expiresAt: number;
};

export class AuthConfigurationError extends Error {
  constructor() {
    super("登录服务尚未配置");
    this.name = "AuthConfigurationError";
  }
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("请先登录");
    this.name = "AuthenticationRequiredError";
  }
}

function env(name: string) {
  return (process.env[name] || "").trim();
}

function configuredInviteCodes() {
  return [...new Set(env("INVITE_CODES").split(",").map(value => value.trim()).filter(Boolean))];
}

export function isAuthenticationRequired() {
  return process.env.NODE_ENV === "production"
    || env("ENV").toLowerCase() === "prod"
    || Boolean(env("INVITE_CODES") || env("SESSION_SECRET") || env("OWNER_ID_SECRET"));
}

function authConfiguration() {
  const inviteCodes = configuredInviteCodes();
  const sessionSecret = env("SESSION_SECRET");
  const ownerIdSecret = env("OWNER_ID_SECRET");
  const hasPlaceholder = [...inviteCodes, sessionSecret, ownerIdSecret].some(value => value.toLowerCase().startsWith("replace_with_"));
  if (
    !inviteCodes.length
    || inviteCodes.some(code => code.length < 12 || code.length > 128)
    || sessionSecret.length < 32
    || ownerIdSecret.length < 32
    || sessionSecret === ownerIdSecret
    || hasPlaceholder
  ) {
    throw new AuthConfigurationError();
  }
  return { inviteCodes, sessionSecret, ownerIdSecret };
}

function digest(value: string, secret: string) {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function deriveUserId(inviteCode: string, ownerIdSecret: string) {
  return `usr-${createHmac("sha256", ownerIdSecret).update(inviteCode, "utf8").digest("hex").slice(0, 40)}`;
}

function allowedUserIds(inviteCodes: string[], ownerIdSecret: string) {
  return new Set(inviteCodes.map(code => deriveUserId(code, ownerIdSecret)));
}

export function authenticateInvite(inviteCode: string): string | null {
  const candidate = inviteCode.trim();
  if (!candidate || candidate.length > 128) return null;
  const { inviteCodes, sessionSecret, ownerIdSecret } = authConfiguration();
  const candidateDigest = digest(candidate, sessionSecret);
  const match = inviteCodes.find(code => safeEqual(digest(code, sessionSecret), candidateDigest));
  return match ? deriveUserId(match, ownerIdSecret) : null;
}

function signTokenBody(body: string, sessionSecret: string) {
  return createHmac("sha256", sessionSecret).update(`${TOKEN_VERSION}.${body}`, "utf8").digest("base64url");
}

export function createSessionToken(userId: string, now = Date.now()) {
  if (!USER_ID_PATTERN.test(userId)) throw new AuthenticationRequiredError();
  const { inviteCodes, sessionSecret, ownerIdSecret } = authConfiguration();
  if (!allowedUserIds(inviteCodes, ownerIdSecret).has(userId)) throw new AuthenticationRequiredError();
  const issuedAt = Math.floor(now / 1000);
  const payload: SessionPayload = {
    v: 1,
    sub: userId,
    iat: issuedAt,
    exp: issuedAt + SESSION_MAX_AGE_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${TOKEN_VERSION}.${body}.${signTokenBody(body, sessionSecret)}`;
}

function cookieValue(request: Request, name: string) {
  const cookieHeader = request.headers.get("cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

export function verifySessionToken(token: string, now = Date.now()): AuthSession | null {
  if (!isAuthenticationRequired()) {
    return { userId: "usr-0000000000000000000000000000000000000000", expiresAt: now + SESSION_MAX_AGE_SECONDS * 1000 };
  }
  const { inviteCodes, sessionSecret, ownerIdSecret } = authConfiguration();
  const [version, body, signature, ...rest] = token.split(".");
  if (version !== TOKEN_VERSION || !body || !signature || rest.length) return null;
  const expectedSignature = Buffer.from(signTokenBody(body, sessionSecret), "utf8");
  const receivedSignature = Buffer.from(signature, "utf8");
  if (!safeEqual(expectedSignature, receivedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<SessionPayload>;
    const nowSeconds = Math.floor(now / 1000);
    if (payload.v !== 1 || typeof payload.sub !== "string" || !USER_ID_PATTERN.test(payload.sub)) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (
      (payload.iat as number) <= 0
      || (payload.iat as number) > nowSeconds + 300
      || (payload.exp as number) <= nowSeconds
      || (payload.exp as number) - (payload.iat as number) !== SESSION_MAX_AGE_SECONDS
    ) return null;
    if (!allowedUserIds(inviteCodes, ownerIdSecret).has(payload.sub)) return null;
    return { userId: payload.sub, expiresAt: (payload.exp as number) * 1000 };
  } catch {
    return null;
  }
}

export function getSessionFromRequest(request: Request): AuthSession | null {
  return verifySessionToken(cookieValue(request, SESSION_COOKIE_NAME));
}

export function requireSession(request: Request): AuthSession {
  const session = getSessionFromRequest(request);
  if (!session) throw new AuthenticationRequiredError();
  return session;
}

export function responseForAuthError(error: unknown): Response | null {
  if (error instanceof AuthenticationRequiredError) {
    return Response.json(
      { error: "请先登录", code: "AUTH_REQUIRED" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (error instanceof AuthConfigurationError) {
    return Response.json(
      { error: "登录服务尚未配置", code: "AUTH_NOT_CONFIGURED" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || env("ENV").toLowerCase() === "prod",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    priority: "high" as const,
  };
}

export function expiredCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || env("ENV").toLowerCase() === "prod",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
    expires: new Date(0),
  };
}
