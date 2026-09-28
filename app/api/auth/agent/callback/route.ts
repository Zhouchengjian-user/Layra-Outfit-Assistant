import { NextRequest, NextResponse } from "next/server";
import { AGENT_TRANSACTION_COOKIE, agentAppHome, agentIdentityConfig, agentIdentityDiscovery, agentTransactionCookieOptions, exchangeAgentCode, readAgentTransaction } from "../../../../lib/agent-identity";
import { LEGACY_OWNER_COOKIE_NAME, SESSION_COOKIE_NAME, agentIdentityUserId, createSessionToken, expiredCookieOptions, sessionCookieOptions } from "../../../../lib/auth";

export async function GET(request: NextRequest) {
  const home = agentAppHome(request.url);
  const respond = (error?: string) => {
    if (error) home.searchParams.set("auth_error", error);
    const response = NextResponse.redirect(home, 302);
    response.cookies.set(AGENT_TRANSACTION_COOKIE, "", { ...agentTransactionCookieOptions(), maxAge: 0 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  if (request.nextUrl.searchParams.has("error")) return respond("denied");
  const code = request.nextUrl.searchParams.get("code") || "";
  const state = request.nextUrl.searchParams.get("state") || "";
  if (!code || code.length > 4096) return respond("invalid");
  try {
    const transaction = readAgentTransaction(request.cookies.get(AGENT_TRANSACTION_COOKIE)?.value || "", state);
    if (!transaction) return respond("invalid");
    const config = agentIdentityConfig();
    const discovery = await agentIdentityDiscovery(config);
    const subject = await exchangeAgentCode(config, discovery, code, transaction);
    const ownerId = agentIdentityUserId(config.issuer, subject);
    const response = respond();
    response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(ownerId, Date.now(), "account"), sessionCookieOptions());
    response.cookies.set(LEGACY_OWNER_COOKIE_NAME, "", expiredCookieOptions());
    return response;
  } catch {
    return respond("invalid");
  }
}
