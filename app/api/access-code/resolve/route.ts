import { NextRequest, NextResponse } from "next/server";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { checkRateLimit } from "@/lib/rateLimit";
import { hashAccessCode, normalizeAccessCode, timingSafeEqualHex } from "@/lib/accessCode";

export async function GET(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const limit = checkRateLimit(`access-code-resolve:${ip}`, 20, 60_000);
  if (!limit.allowed) {
    return NextResponse.json({ error: "リクエストが多すぎます" }, { status: 429 });
  }

  const code = normalizeAccessCode(String(request.nextUrl.searchParams.get("code") || ""));
  if (!code) {
    return NextResponse.json({ error: "code が必要です" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const codeHash = hashAccessCode(code);

    const codeSnap = await firestore.collection("operatorAccessCodes").doc(codeHash).get();
    const codeData = codeSnap.data();
    if (codeSnap.exists && codeData?.status === "active" && codeData?.tournamentId) {
      return NextResponse.json({ valid: true, tournamentId: String(codeData.tournamentId) });
    }

    // 旧データ互換
    const legacySnap = await firestore.collection("tournaments").where("operatorAccessCode", "==", code).limit(1).get();
    if (!legacySnap.empty) {
      return NextResponse.json({ valid: true, tournamentId: legacySnap.docs[0].id });
    }

    const hashSnap = await firestore.collection("tournaments").where("operatorAccessCodeHash", "==", codeHash).limit(1).get();
    if (!hashSnap.empty) {
      const doc = hashSnap.docs[0];
      const activeHash = String(doc.data()?.operatorAccessCodeHash || "").trim();
      if (activeHash && timingSafeEqualHex(activeHash, codeHash)) {
        return NextResponse.json({ valid: true, tournamentId: doc.id });
      }
    }

    return NextResponse.json({ valid: false });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "大会コード解決エラー" }, { status: 500 });
  }
}
