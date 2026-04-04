import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie, requireSession } from "@/lib/session";
import { fetchViewer } from "@/lib/startgg";

export async function GET(request: NextRequest) {
  const authn = requireSession(request);
  if (!authn.ok) return authn.response;

  const accessToken = request.cookies.get("startgg_access_token")?.value;
  if (authn.session.mode === "startgg" && accessToken) {
    const viewer = await fetchViewer(accessToken);
    if (!viewer?.id) {
      const response = NextResponse.json({ authenticated: false, error: "start.gg セッションが失効しました" }, { status: 401 });
      clearSessionCookie(response);
      response.cookies.set("startgg_access_token", "", { path: "/", maxAge: 0 });
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
