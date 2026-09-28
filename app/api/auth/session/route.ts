import { NextResponse } from "next/server";
import { AuthConfigurationError, getSessionFromRequest, isInviteLoginAvailable } from "../../../lib/auth";
import { isAgentIdentityAvailable } from "../../../lib/agent-identity";

export async function GET(request: Request) {
  try {
    const session = getSessionFromRequest(request);
    const response = NextResponse.json({ authenticated: Boolean(session), provider: session?.provider, inviteAvailable: isInviteLoginAvailable(), accountAvailable: isAgentIdentityAvailable() }, { status: session ? 200 : 401 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return NextResponse.json({ authenticated: false, error: "登录服务尚未配置", code: "AUTH_NOT_CONFIGURED" }, { status: 503 });
    }
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
}
