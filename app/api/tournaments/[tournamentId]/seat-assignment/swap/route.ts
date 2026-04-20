import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { getActorFromSession, requireTournamentAccess } from "@/lib/authz";

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg", "operator_code"]);
  if (!authz.ok) return authz.response;

  const body = await request.json().catch(() => null);
  const participantIdA = String(body?.participantIdA || "").trim();
  const participantIdB = String(body?.participantIdB || "").trim();
  if (!participantIdA || !participantIdB || participantIdA === participantIdB) {
    return NextResponse.json({ error: "participantIdA / participantIdB が不正です" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const actor = getActorFromSession(authz.session);
    const tournamentRef = firestore.collection("tournaments").doc(params.tournamentId);
    const participantsCol = tournamentRef.collection("participants");
    const seatsCol = tournamentRef.collection("seats");

    await firestore.runTransaction(async (tx) => {
      const refA = participantsCol.doc(participantIdA);
      const refB = participantsCol.doc(participantIdB);
      const snapA = await tx.get(refA);
      const snapB = await tx.get(refB);
      if (!snapA.exists || !snapB.exists) throw new Error("NOT_FOUND");

      const dataA = snapA.data() || {};
      const dataB = snapB.data() || {};
      const seatA = String(dataA.seatLabel || dataA.adminNotes || "").trim();
      const seatB = String(dataB.seatLabel || dataB.adminNotes || "").trim();
      if (!seatA || !seatB) throw new Error("NO_ASSIGNED_SEAT");

      tx.set(refA, {
        seatLabel: seatB,
        adminNotes: seatB,
        updatedAt: FieldValue.serverTimestamp(),
        adminLogEntries: FieldValue.arrayUnion(`[${new Date().toISOString()}] ${actor.actorDisplayName}: 台番号スワップ ${seatA} -> ${seatB} (${participantIdB})`),
      }, { merge: true });
      tx.set(refB, {
        seatLabel: seatA,
        adminNotes: seatA,
        updatedAt: FieldValue.serverTimestamp(),
        adminLogEntries: FieldValue.arrayUnion(`[${new Date().toISOString()}] ${actor.actorDisplayName}: 台番号スワップ ${seatB} -> ${seatA} (${participantIdA})`),
      }, { merge: true });

      tx.set(seatsCol.doc(seatA), {
        seatLabel: seatA,
        assignedParticipantId: participantIdB,
        assignmentType: String(seatA).startsWith("予備台") ? "reserve" : "normal",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.set(seatsCol.doc(seatB), {
        seatLabel: seatB,
        assignedParticipantId: participantIdA,
        assignmentType: String(seatB).startsWith("予備台") ? "reserve" : "normal",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    const message = error?.message === "NOT_FOUND"
      ? "対象参加者が見つかりません"
      : error?.message === "NO_ASSIGNED_SEAT"
        ? "どちらかの参加者に台番号が割り当てられていません"
        : (error?.message || "台番号スワップ失敗");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
