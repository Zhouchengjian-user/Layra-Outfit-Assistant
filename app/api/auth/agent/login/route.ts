import { NextResponse } from "next/server";
import { AGENT_TRANSACTION_COOKIE, agentAppHome, agentAuthorizeUrl, agentIdentityConfig, agentIdentityDiscovery, agentTransactionCookieOptions, newAgentTransaction, sealAgentTransaction } from "../../../../lib/agent-identity";

export async function GET(request: Request) {
  try {
    const config = agentIdentityConfig();
    const discovery = await agentIdentityDiscovery(config);
    const transaction = newAgentTransaction();
    const response = NextResponse.redirect(agentAuthorizeUrl(config, discovery, transaction), 302);
    response.cookies.set(AGENT_TRANSACTION_COOKIE, sealAgentTransaction(transaction), agentTransactionCookieOptions());
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch {
    const home = agentAppHome(request.url);
    home.searchParams.set("auth_error", "unavailable");
    return NextResponse.redirect(home, 302);
  }
}
