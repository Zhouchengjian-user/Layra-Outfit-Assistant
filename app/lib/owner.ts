import { requireSession } from "./auth";

export type Owner = { id: string; isNew: false };

export function getOwner(request: Request): Owner {
  return { id: requireSession(request).userId, isNew: false };
}

export function withOwnerCookie(response: Response, owner: Owner) {
  void owner;
  return response;
}

export function ownerJson(payload: unknown, owner: Owner, status = 200) {
  return withOwnerCookie(Response.json(payload, { status }), owner);
}
