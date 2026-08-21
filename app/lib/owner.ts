export type Owner = { id: string; isNew: boolean };

export function getOwner(request: Request): Owner {
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)yida_owner=([a-zA-Z0-9-]{20,80})/);
  return match ? { id: match[1], isNew: false } : { id: crypto.randomUUID(), isNew: true };
}

export function withOwnerCookie(response: Response, owner: Owner) {
  if (owner.isNew) {
    // 不设 Secure / 不写死 domain：让本地 http、隧道 https、正式部署都能写入同一 cookie
    response.headers.append("Set-Cookie", `yida_owner=${owner.id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`);
  }
  return response;
}

export function ownerJson(payload: unknown, owner: Owner, status = 200) {
  return withOwnerCookie(Response.json(payload, { status }), owner);
}
