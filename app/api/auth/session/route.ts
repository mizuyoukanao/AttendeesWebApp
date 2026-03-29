import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const GRAPHQL_URL = "https://api.start.gg/gql/alpha";

function readUserCookie() {
  const encoded = cookies().get("startgg_user")?.value;
  if (!encoded) return null;
  try {
    const json = Buffer.from(encoded, "base64").toString("utf-8");
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
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
        query: `query Viewer { currentUser { id slug name player { gamerTag } } }`,
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (data?.errors?.length) return null;
    return data?.data?.currentUser ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const accessToken = cookies().get("startgg_access_token")?.value;
  let user = readUserCookie();
  if (accessToken && !user) {
    const viewer = await fetchViewer(accessToken);
    if (viewer) {
      user = {
        id: viewer.id,
        slug: viewer.slug,
        name: viewer.name,
        gamerTag: viewer?.player?.gamerTag || null,
      };
      const response = NextResponse.json({ authenticated: true, user });
      response.cookies.set(
        "startgg_user",
        Buffer.from(JSON.stringify(user)).toString("base64"),
        {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: 60 * 60,
        },
      );
      return response;
    }
  }

  return NextResponse.json({
    authenticated: Boolean(accessToken),
    user,
  });
}
