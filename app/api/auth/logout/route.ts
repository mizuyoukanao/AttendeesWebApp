import { NextResponse } from "next/server";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  ["startgg_access_token", "startgg_refresh_token", "startgg_user", "startgg_oauth_state"].forEach((name) => {
    response.cookies.set(name, "", { path: "/", maxAge: 0 });
  });
  return response;
}
