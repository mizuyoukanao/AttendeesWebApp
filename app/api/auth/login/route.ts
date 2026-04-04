import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/rateLimit";

const AUTH_URL = "https://start.gg/oauth/authorize";

export async function GET(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`auth-login:${ip}`, 20, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: "リクエストが多すぎます" }, { status: 429 });
  }
  const clientId = process.env.SGGCID;
  const redirectUri = process.env.STARTGG_REDIRECT_URI;
  const scope = process.env.SGGOASCP || "user.identity tournament.manager";

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "OAuthクライアント環境変数が未設定です" }, { status: 500 });
  }

  const state = crypto.randomBytes(16).toString("hex");
  const url = new URL(AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);

  const response = NextResponse.redirect(url.toString());
  response.cookies.set("startgg_oauth_state", state, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 10,
  });
  return response;
}
