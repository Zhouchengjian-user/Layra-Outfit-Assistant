import { NextResponse } from "next/server";
import {
  AuthConfigurationError,
  LEGACY_OWNER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  authenticateInvite,
  createSessionToken,
  expiredCookieOptions,
  sessionCookieOptions,
} from "../../../lib/auth";

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json({ error: "请输入邀请码", code: "INVALID_REQUEST" }, { status: 400 });
    }
    const body = await request.json().catch(() => null) as { inviteCode?: unknown } | null;
    const inviteCode = typeof body?.inviteCode === "string" ? body.inviteCode.trim() : "";
    if (!inviteCode || inviteCode.length > 128) {
      return NextResponse.json({ error: "邀请码无效，请确认后重试", code: "INVALID_INVITE_CODE" }, { status: 401 });
    }
    const userId = authenticateInvite(inviteCode);
    if (!userId) {
      // 固定延迟降低在线穷举速度，不记录邀请码原文。
      await new Promise(resolve => setTimeout(resolve, 250));
      return NextResponse.json({ error: "邀请码无效，请确认后重试", code: "INVALID_INVITE_CODE" }, { status: 401 });
    }
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(userId), sessionCookieOptions());
    response.cookies.set(LEGACY_OWNER_COOKIE_NAME, "", expiredCookieOptions());
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return NextResponse.json({ error: "登录服务尚未配置", code: "AUTH_NOT_CONFIGURED" }, { status: 503 });
    }
    return NextResponse.json({ error: "登录失败，请稍后重试", code: "AUTH_FAILED" }, { status: 500 });
  }
}
