import { NextResponse } from "next/server";
import { APP_SESSION_COOKIE } from "@/lib/session";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  ["startgg_access_token", "startgg_refresh_token", "startgg_oauth_state", APP_SESSION_COOKIE].forEach((name) => {
    response.cookies.set(name, "", { path: "/", maxAge: 0 });
  });
  return response;
}
