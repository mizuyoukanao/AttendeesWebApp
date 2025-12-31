import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";

function formatTimestampJst(date: Date) {
  const offsetMs = 9 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const yyyy = local.getUTCFullYear();
  const mm = `${local.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${local.getUTCDate()}`.padStart(2, "0");
  const hh = `${local.getUTCHours()}`.padStart(2, "0");
  const min = `${local.getUTCMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} JST`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string; participantId: string } },
) {
  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが空です" }, { status: 400 });
  }

  const delta = Number(body.deltaAmount ?? 0);
  const reasonLabel = String(body.reasonLabel || "").trim();
  const operatorUserId = String(body.operatorUserId || "operator").trim();

  try {
    const firestore = ensureFirestore();
    const docRef = firestore
      .collection("tournaments")
      .doc(params.tournamentId)
      .collection("participants")
      .doc(params.participantId);

    const snap = await docRef.get();
    if (!snap.exists) {
      return NextResponse.json({ error: "参加者が存在しません" }, { status: 404 });
    }

    const existing = snap.data() || {};
    if (existing.checkedIn) {
      return NextResponse.json({ error: "すでにチェックイン済みです" }, { status: 400 });
    }

    const timestamp = new Date();
    const noteEntry = delta !== 0 || reasonLabel
      ? `${formatTimestampJst(timestamp)} | ${reasonLabel || "チェックイン"} | ${delta >= 0 ? `+${delta}` : delta}円`
      : `${formatTimestampJst(timestamp)} | チェックイン | 0円`;

    await docRef.set(
      {
        checkedIn: true,
        checkedInAt: FieldValue.serverTimestamp(),
        checkedInBy: operatorUserId,
        editNotes: existing.editNotes ? `${existing.editNotes}\n${noteEntry}` : noteEntry,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json({ ok: true, noteEntry });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "チェックイン更新エラー" }, { status: 500 });
  }
}
