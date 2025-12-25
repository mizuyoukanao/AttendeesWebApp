import { NextRequest, NextResponse } from "next/server";

const TOKEN_URL = "https://api.start.gg/oauth/token";
const GRAPHQL_URL = "https://api.start.gg/gql/alpha";

async function exchangeCodeForToken(code: string, redirectUri: string) {
  const clientId = process.env.STARTGG_CLIENT_ID;
  const clientSecret = process.env.STARTGG_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("クライアントID/シークレットが未設定です");
  }

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`トークン取得に失敗しました: ${response.status} ${text}`);
  }

  return response.json();
}

async function fetchViewer(accessToken: string) {
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `query Viewer { currentUser { id slug email gamerTag } }`,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data?.data?.currentUser ?? null;
  } catch (error) {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const savedState = request.cookies.get("startgg_oauth_state")?.value;
  const redirectUri = process.env.STARTGG_REDIRECT_URI;

  if (!redirectUri) {
    return NextResponse.json({ error: "STARTGG_REDIRECT_URI が未設定です" }, { status: 500 });
  }

  if (!code || !state) {
    return NextResponse.json({ error: "code/state が不足しています" }, { status: 400 });
  }

  if (!savedState || savedState !== state) {
    return NextResponse.json({ error: "state が一致しません" }, { status: 400 });
  }

  try {
    const tokenResponse = await exchangeCodeForToken(code, redirectUri);
    const accessToken = tokenResponse.access_token as string;
    const refreshToken = tokenResponse.refresh_token as string | undefined;
    const expiresIn = tokenResponse.expires_in as number | undefined;

    const viewer = accessToken ? await fetchViewer(accessToken) : null;

    const response = NextResponse.redirect(new URL("/", request.url));
    response.cookies.set("startgg_oauth_state", "", { path: "/", maxAge: 0 });
    response.cookies.set("startgg_access_token", accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: expiresIn ?? 60 * 60,
    });

    if (refreshToken) {
      response.cookies.set("startgg_refresh_token", refreshToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    if (viewer) {
      response.cookies.set(
        "startgg_user",
        Buffer.from(JSON.stringify({
          id: viewer.id,
          slug: viewer.slug,
          email: viewer.email,
          gamerTag: viewer.gamerTag,
        })).toString("base64"),
        {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: expiresIn ?? 60 * 60,
        },
      );
    }

    return response;
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "OAuthエラー" }, { status: 400 });
  }
}
