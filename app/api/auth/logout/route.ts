import { NextResponse } from "next/server";
import {
  LEGACY_OWNER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  expiredCookieOptions,
} from "../../../lib/auth";

export async function POST() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(SESSION_COOKIE_NAME, "", expiredCookieOptions());
  response.cookies.set(LEGACY_OWNER_COOKIE_NAME, "", expiredCookieOptions());
  response.headers.set("Cache-Control", "no-store");
  return response;
}
