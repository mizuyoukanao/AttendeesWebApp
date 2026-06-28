import { NextRequest, NextResponse } from "next/server";
import { applySessionCookie, clearSessionCookie, createSignedSession, requireSession } from "@/lib/session";
import { buildSessionTournamentIds, fetchManagedTournaments, fetchViewer } from "@/lib/startgg";

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

    const managedTournaments = await fetchManagedTournaments(accessToken);
    const rebuilt = buildSessionTournamentIds(managedTournaments, { pinnedTournamentId: authn.session.pinnedTournamentId });
    const currentPinned = authn.session.pinnedTournamentId;
    const nextPinned = rebuilt.pinnedTournamentId;
    const sameIds = authn.session.allowedTournamentIds.length === rebuilt.allowedTournamentIds.length
      && authn.session.allowedTournamentIds.every((id, i) => id === rebuilt.allowedTournamentIds[i]);

    const nextSession = {
      ...authn.session,
      allowedTournamentIds: rebuilt.allowedTournamentIds,
      pinnedTournamentId: nextPinned,
    };

    const response = NextResponse.json({
      authenticated: true,
      session: nextSession,
      user: {
        id: nextSession.userId,
        name: nextSession.displayName,
      },
    });

    if (!sameIds || currentPinned !== nextPinned) {
      const signedSession = createSignedSession(nextSession);
      const now = Math.floor(Date.now() / 1000);
      applySessionCookie(response, signedSession, Math.max(1, authn.session.exp - now));
    }

    return response;
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
