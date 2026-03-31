import { NextRequest, NextResponse } from "next/server";
import { ensureFirestore } from "@/lib/firebaseAdmin";

export async function GET(request: NextRequest) {
  const code = String(request.nextUrl.searchParams.get("code") || "").trim();
  if (!code) {
    return NextResponse.json({ error: "code が必要です" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const codeSnap = await firestore.collection("operatorAccessCodes").doc(code).get();
    const codeData = codeSnap.data();
    if (codeSnap.exists && codeData?.status === "active" && codeData?.tournamentId) {
      return NextResponse.json({
        valid: true,
        tournamentId: String(codeData.tournamentId),
        tournamentName: codeData?.tournamentName || null,
      });
    }

    // 旧データ互換: tournaments/{id}.operatorAccessCode を参照
    const legacySnap = await firestore
      .collection("tournaments")
      .where("operatorAccessCode", "==", code)
      .limit(1)
      .get();
    if (!legacySnap.empty) {
      const doc = legacySnap.docs[0];
      return NextResponse.json({
        valid: true,
        tournamentId: doc.id,
        tournamentName: doc.data()?.name || null,
      });
    }

    return NextResponse.json({ valid: false });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "大会コード解決エラー" }, { status: 500 });
  }
}
