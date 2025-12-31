import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

const AUTH_URL = "https://start.gg/oauth/authorize";

export async function GET(request: NextRequest) {
  const clientId = process.env.STARTGG_CLIENT_ID;
  const redirectUri = process.env.STARTGG_REDIRECT_URI;
  const scope = process.env.STARTGG_OAUTH_SCOPE || "identity tournaments:read";

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
