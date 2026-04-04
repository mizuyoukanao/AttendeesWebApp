import { NextRequest, NextResponse } from "next/server";
import { AppSession, SessionMode, requireSession } from "@/lib/session";

export function requireTournamentAccess(
  request: NextRequest,
  tournamentId: string,
  allowedModes: SessionMode[] = ["startgg", "operator_code"],
):
  | { ok: true; session: AppSession }
  | { ok: false; response: NextResponse } {
  const authn = requireSession(request);
  if (!authn.ok) return authn;

  const { session } = authn;
  if (!allowedModes.includes(session.mode)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "この操作は許可されていません" }, { status: 403 }),
    };
  }

  if (!session.allowedTournamentIds.includes(String(tournamentId))) {
    return {
      ok: false,
      response: NextResponse.json({ error: "大会へのアクセス権限がありません" }, { status: 403 }),
    };
  }

  return { ok: true, session };
}

export function getActorFromSession(session: AppSession) {
  return {
    actorType: session.mode,
    actorId: session.userId,
    actorDisplayName: session.displayName,
  };
}
