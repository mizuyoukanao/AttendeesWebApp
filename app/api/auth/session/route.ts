import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, requireSession } from "@/lib/session";
import { fetchViewer } from "@/lib/startgg";

function clearStartggCookie(response: NextResponse) {
  response.cookies.set("startgg_access_token", "", { path: "/", maxAge: 0 });
}

export async function GET(request: NextRequest) {
  const authn = requireSession(request);
  if (!authn.ok) return authn.response;

  if (authn.session.mode === "startgg") {
    const accessToken = request.cookies.get("startgg_access_token")?.value;
    if (!accessToken) {
      const response = NextResponse.json({ authenticated: false, error: "start.gg セッションが失効しました" }, { status: 401 });
      clearSessionCookie(response);
      clearStartggCookie(response);
      return response;
    }

    const viewer = await fetchViewer(accessToken);
    if (!viewer?.id) {
      const response = NextResponse.json({ authenticated: false, error: "start.gg セッションが失効しました" }, { status: 401 });
      clearSessionCookie(response);
      clearStartggCookie(response);
      return response;
    }
  }

  return NextResponse.json({
    authenticated: true,
    session: authn.session,
    user: {
      id: authn.session.userId,
      name: authn.session.displayName,
    },
  });
}
