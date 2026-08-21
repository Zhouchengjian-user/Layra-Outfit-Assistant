import { NextResponse, type NextRequest } from "next/server";
import { AuthConfigurationError, getSessionFromRequest } from "./app/lib/auth";
import { traceIdFromRequest } from "./app/lib/observability";

const PUBLIC_API_ROUTES = new Set([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
  "/api/weather",
]);

export function proxy(request: NextRequest) {
  const traceId = traceIdFromRequest(request);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-request-id", traceId);
  const next = () => {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("X-Trace-Id", traceId);
    return response;
  };
  const json = (body: Record<string, unknown>, status: number) => {
    const response = NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "no-store", "X-Trace-Id": traceId },
    });
    return response;
  };

  if (PUBLIC_API_ROUTES.has(request.nextUrl.pathname)) return next();
  try {
    if (getSessionFromRequest(request)) return next();
    return json({ error: "请先登录", code: "AUTH_REQUIRED" }, 401);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return json({ error: "登录服务尚未配置", code: "AUTH_NOT_CONFIGURED" }, 503);
    }
    return json({ error: "请先登录", code: "AUTH_REQUIRED" }, 401);
  }
}

export const config = {
  matcher: ["/api/:path*"],
};
