import { NextRequest, NextResponse } from "next/server";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { checkRateLimit, getRequestIp } from "@/lib/rateLimit";
import { createOperatorSignedSession, setSessionCookie } from "@/lib/session";
import { hashAccessCode, normalizeAccessCode } from "@/lib/accessCode";

const OPERATOR_SESSION_RATE_LIMIT = 50;
const OPERATOR_SESSION_RATE_WINDOW_SECONDS = 300;

export async function POST(request: NextRequest) {
  const ip = getRequestIp(request.headers);
  const limit = await checkRateLimit({
    namespace: "operator_session",
    ip,
    limit: OPERATOR_SESSION_RATE_LIMIT,
    windowSeconds: OPERATOR_SESSION_RATE_WINDOW_SECONDS,
  });
  if (!limit.allowed) {
    return NextResponse.json({ error: "リクエストが多すぎます", retryAfterSeconds: limit.retryAfterSeconds }, { status: 429 });
  }

  const body = await request.json().catch(() => null);
  const code = normalizeAccessCode(String(body?.code || ""));
  const handleName = String(body?.handleName || "").trim() || "code-operator";

  if (!code) {
    return NextResponse.json({ error: "code が必要です" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const codeHash = hashAccessCode(code);
    const codeSnap = await firestore.collection("operatorAccessCodes").doc(codeHash).get();
    const codeData = codeSnap.data();

    if (!codeSnap.exists || codeData?.status !== "active" || !codeData?.tournamentId) {
      return NextResponse.json({ error: "コードが無効です" }, { status: 401 });
    }

    const tournamentId = String(codeData.tournamentId);
    const tournamentSnap = await firestore.collection("tournaments").doc(tournamentId).get();
    const activeHash = String(tournamentSnap.data()?.operatorAccessCodeHash || "").trim();
    if (!activeHash || activeHash !== codeHash) {
      return NextResponse.json({ error: "コードが無効です" }, { status: 401 });
    }
    const session = createOperatorSignedSession({
      userId: `operator:${handleName}`,
      displayName: handleName,
      tournamentId,
    });

    const response = NextResponse.json({ ok: true, tournamentId, mode: "operator_code" as const });
    response.cookies.set("startgg_access_token", "", { path: "/", maxAge: 0 });
    response.cookies.set("startgg_refresh_token", "", { path: "/", maxAge: 0 });
    setSessionCookie(response, session, 60 * 60 * 4);
    return response;
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "operator session エラー" }, { status: 500 });
  }
}
