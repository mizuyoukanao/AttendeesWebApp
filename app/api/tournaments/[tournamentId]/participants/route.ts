import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";

type ParticipantPayload = {
  participantId: string;
  playerName?: string;
  adminNotes?: string;
  checkedIn?: boolean;
  payment?: {
    totalTransaction?: number;
    totalOwed?: number;
    totalPaid?: number;
  };
  editNotes?: string;
};

function normalizeParticipant(input: any): ParticipantPayload | null {
  const participantId = String(input?.participantId || input?.Id || "").trim();
  if (!participantId) return null;

  const payment = input?.payment || input || {};

  return {
    participantId,
    playerName: String(input?.playerName || input?.GamerTag || input?.["GamerTag"] || input?.["Short GamerTag"] || "").trim() || participantId,
    adminNotes: String(input?.adminNotes || input?.["Admin Notes"] || "").trim() || undefined,
    checkedIn: Boolean(input?.checkedIn ?? input?.["Checked In"] ?? false),
    payment: {
      totalTransaction: Number(payment.totalTransaction ?? payment["Total Transaction"] ?? 0),
      totalOwed: Number(payment.totalOwed ?? payment["Total Owed"] ?? 0),
      totalPaid: Number(payment.totalPaid ?? payment["Total Paid"] ?? 0),
    },
    editNotes: typeof input?.editNotes === "string" ? input.editNotes : undefined,
  };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  try {
    const firestore = ensureFirestore();
    const participantsSnap = await firestore
      .collection("tournaments")
      .doc(params.tournamentId)
      .collection("participants")
      .orderBy("participantId")
      .get();

    const participants = participantsSnap.docs.map((doc) => ({ participantId: doc.id, ...doc.data() }));
    return NextResponse.json({ participants });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "participants取得エラー" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const body = await request.json().catch(() => null);
  const rows: any[] = Array.isArray(body?.participants) ? body.participants : Array.isArray(body) ? body : [];

  if (!rows.length) {
    return NextResponse.json({ error: "participants配列が空です" }, { status: 400 });
  }

  const participants = rows
    .map(normalizeParticipant)
    .filter((p): p is ParticipantPayload => Boolean(p));

  if (!participants.length) {
    return NextResponse.json({ error: "取り込める参加者がありません" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const participantsCol = firestore.collection("tournaments").doc(params.tournamentId).collection("participants");

    for (const participant of participants) {
      const docRef = participantsCol.doc(participant.participantId);
      const existingSnap = await docRef.get();
      const existing = existingSnap.exists ? existingSnap.data() : {};

      const mergedCheckedIn = Boolean(existing?.checkedIn) || Boolean(participant.checkedIn);

      await docRef.set(
        {
          participantId: participant.participantId,
          playerName: participant.playerName,
          adminNotes: participant.adminNotes ?? null,
          payment: {
            totalTransaction: participant.payment?.totalTransaction ?? 0,
            totalOwed: participant.payment?.totalOwed ?? 0,
            totalPaid: participant.payment?.totalPaid ?? 0,
          },
          checkedIn: mergedCheckedIn,
          checkedInAt: mergedCheckedIn ? existing?.checkedInAt ?? FieldValue.serverTimestamp() : null,
          editNotes: participant.editNotes ?? existing?.editNotes ?? "",
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    return NextResponse.json({ ok: true, count: participants.length });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "participants保存エラー" }, { status: 500 });
  }
}
