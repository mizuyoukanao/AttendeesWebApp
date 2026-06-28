import { NextRequest, NextResponse } from "next/server";
import { AppSession, SessionMode, createSignedSession, requireSession } from "@/lib/session";
import { buildSessionTournamentIds, fetchManagedTournaments } from "@/lib/startgg";

type RefreshedSessionCookie = {
  signedSession: string;
  maxAgeSeconds: number;
};

export async function requireTournamentAccess(
  request: NextRequest,
  tournamentId: string,
  allowedModes: SessionMode[] = ["startgg", "operator_code"],
): Promise<
  | { ok: true; session: AppSession; refreshedSessionCookie?: RefreshedSessionCookie }
  | { ok: false; response: NextResponse }
> {
  const authn = requireSession(request);
  if (!authn.ok) return authn;

  const { session } = authn;
  if (!allowedModes.includes(session.mode)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "この操作は許可されていません" }, { status: 403 }),
    };
  }

  const requestedTournamentId = String(tournamentId);
  if (session.allowedTournamentIds.includes(requestedTournamentId)) {
    return { ok: true, session };
  }

  if (session.mode !== "startgg") {
    return {
      ok: false,
      response: NextResponse.json({ error: "大会へのアクセス権限がありません" }, { status: 403 }),
    };
  }

  const accessToken = request.cookies.get("startgg_access_token")?.value;
  if (!accessToken) {
    return {
      ok: false,
      response: NextResponse.json({ error: "大会へのアクセス権限がありません" }, { status: 403 }),
    };
  }

  try {
    const managedTournaments = await fetchManagedTournaments(accessToken);
    const rebuilt = buildSessionTournamentIds(managedTournaments, { pinnedTournamentId: requestedTournamentId });

    if (!rebuilt.allowedTournamentIds.includes(requestedTournamentId)) {
      return {
        ok: false,
        response: NextResponse.json({ error: "大会へのアクセス権限がありません" }, { status: 403 }),
      };
    }

    const refreshedSession: AppSession = {
      ...session,
      allowedTournamentIds: rebuilt.allowedTournamentIds,
      pinnedTournamentId: rebuilt.pinnedTournamentId,
    };

    const signedSession = createSignedSession(refreshedSession);
    const now = Math.floor(Date.now() / 1000);
    const maxAgeSeconds = Math.max(1, session.exp - now);

    return {
      ok: true,
      session: refreshedSession,
      refreshedSessionCookie: {
        signedSession,
        maxAgeSeconds,
      },
    };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "大会へのアクセス権限がありません" }, { status: 403 }),
    };
  }
}

export function getActorFromSession(session: AppSession) {
  return {
    actorType: session.mode,
    actorId: session.userId,
    actorDisplayName: session.displayName,
  };
}
