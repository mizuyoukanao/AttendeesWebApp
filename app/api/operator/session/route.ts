import { NextRequest, NextResponse } from "next/server";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { checkRateLimit } from "@/lib/rateLimit";
import { createOperatorSignedSession, setSessionCookie } from "@/lib/session";
import { hashAccessCode, normalizeAccessCode, timingSafeEqualHex } from "@/lib/accessCode";

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`operator-session:${ip}`, 10, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: "リクエストが多すぎます" }, { status: 429 });
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

    let tournamentId = "";
    if (codeSnap.exists && codeData?.status === "active" && codeData?.tournamentId) {
      tournamentId = String(codeData.tournamentId);
    } else {
      const hashSnap = await firestore.collection("tournaments").where("operatorAccessCodeHash", "==", codeHash).limit(1).get();
      if (!hashSnap.empty) {
        const doc = hashSnap.docs[0];
        const activeHash = String(doc.data()?.operatorAccessCodeHash || "").trim();
        if (activeHash && timingSafeEqualHex(activeHash, codeHash)) {
          tournamentId = doc.id;
        }
      }

      if (!tournamentId) {
        // 旧データ互換
        const legacySnap = await firestore.collection("tournaments").where("operatorAccessCode", "==", code).limit(1).get();
        if (!legacySnap.empty) {
          tournamentId = legacySnap.docs[0].id;
        }
      }
    }

    if (!tournamentId) {
      return NextResponse.json({ error: "コードが無効です" }, { status: 401 });
    }

    const session = createOperatorSignedSession({
      userId: `operator:${handleName}`,
      displayName: handleName,
      tournamentId,
    });

    const response = NextResponse.json({ ok: true, tournamentId, mode: "operator_code" as const });
    setSessionCookie(response, session, 60 * 60 * 4);
    return response;
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "operator session エラー" }, { status: 500 });
  }
}
