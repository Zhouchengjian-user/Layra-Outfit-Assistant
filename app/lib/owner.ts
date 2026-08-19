export type Owner = { id: string; isNew: boolean };

export function getOwner(request: Request): Owner {
  const match = request.headers.get("cookie")?.match(/(?:^|;\s*)yida_owner=([a-zA-Z0-9-]{20,80})/);
  return match ? { id: match[1], isNew: false } : { id: crypto.randomUUID(), isNew: true };
}

export function withOwnerCookie(response: Response, owner: Owner) {
  if (owner.isNew) {
    response.headers.append("Set-Cookie", `yida_owner=${owner.id}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly; Secure`);
  }
  return response;
}

export function ownerJson(payload: unknown, owner: Owner, status = 200) {
  return withOwnerCookie(Response.json(payload, { status }), owner);
}
