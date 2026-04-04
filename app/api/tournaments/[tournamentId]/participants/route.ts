import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { requireTournamentAccess } from "@/lib/authz";

type ParticipantPayload = {
  participantId: string;
  playerName?: string;
  adminNotes?: string;
  venueFeeName?: string;
  checkedIn?: boolean;
  payment?: {
    totalTransaction?: number;
    totalOwed?: number;
    totalPaid?: number;
  };
};

function toParticipantResponse(id: string, raw: any) {
  return {
    participantId: id,
    playerName: String(raw?.playerName || id),
    adminNotes: String(raw?.adminNotes || ""),
    venueFeeName: String(raw?.venueFeeName || ""),
    payment: {
      totalTransaction: Number(raw?.payment?.totalTransaction ?? 0),
      totalOwed: Number(raw?.payment?.totalOwed ?? 0),
      totalPaid: Number(raw?.payment?.totalPaid ?? 0),
    },
    checkedIn: Boolean(raw?.checkedIn),
    checkedInAt: raw?.checkedInAt?.toDate ? raw.checkedInAt.toDate().toISOString() : raw?.checkedInAt || undefined,
    checkedInBy: raw?.checkedInBy || undefined,
    seatLabel: String(raw?.seatLabel || ""),
  };
}

function normalizeParticipant(input: any): ParticipantPayload | null {
  const participantId = String(input?.participantId || input?.Id || "").trim();
  if (!participantId) return null;

  const payment = input?.payment || input || {};

  return {
    participantId,
    playerName: String(input?.playerName || input?.GamerTag || input?.["GamerTag"] || input?.["Short GamerTag"] || "").trim() || participantId,
    adminNotes: String(input?.adminNotes || input?.["Admin Notes"] || "").trim() || undefined,
    venueFeeName: String(input?.venueFeeName || input?.["Venue Fee Name"] || "").trim() || undefined,
    checkedIn: Boolean(input?.checkedIn ?? input?.["Checked In"] ?? false),
    payment: {
      totalTransaction: Number(payment.totalTransaction ?? payment["Total Transaction"] ?? 0),
      totalOwed: Number(payment.totalOwed ?? payment["Total Owed"] ?? 0),
      totalPaid: Number(payment.totalPaid ?? payment["Total Paid"] ?? 0),
    },
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg", "operator_code"]);
  if (!authz.ok) return authz.response;

  try {
    const firestore = ensureFirestore();
    const participantsSnap = await firestore
      .collection("tournaments")
      .doc(params.tournamentId)
      .collection("participants")
      .orderBy("participantId")
      .get();

    const participants = participantsSnap.docs.map((doc) => toParticipantResponse(doc.id, doc.data()));
    return NextResponse.json({ participants });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "participants取得エラー" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg"]);
  if (!authz.ok) return authz.response;

  const body = await request.json().catch(() => null);
  const rows: any[] = Array.isArray(body?.participants) ? body.participants : Array.isArray(body) ? body : [];

  if (!rows.length) {
    return NextResponse.json({ error: "participants配列が空です" }, { status: 400 });
  }

  const normalized = rows.map(normalizeParticipant);
  const participants = normalized.filter((p): p is ParticipantPayload => Boolean(p));
  const skippedCount = normalized.length - participants.length;

  if (!participants.length) {
    return NextResponse.json({ error: "取り込める参加者がありません" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const tournamentRef = firestore.collection("tournaments").doc(params.tournamentId);
    const participantsCol = tournamentRef.collection("participants");

    const existingSnapshot = await participantsCol.get();
    const existingMap = new Map(existingSnapshot.docs.map((doc) => [doc.id, doc.data()]));
    const uploadedIds = new Set(participants.map((participant) => participant.participantId));

    const importJobId = `import_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const importedAtIso = new Date().toISOString();

    const bulkWriter = firestore.bulkWriter();
    let upsertCount = 0;

    for (const participant of participants) {
      const docRef = participantsCol.doc(participant.participantId);
      const existing = existingMap.get(participant.participantId) || {};
      const preserveCheckedIn = Boolean((existing as any)?.checkedIn);
      const preserveCheckedInAt = (existing as any)?.checkedInAt ?? null;
      const preserveCheckedInBy = (existing as any)?.checkedInBy ?? null;
      const preserveSeatLabel = String((existing as any)?.seatLabel || "").trim() || null;

      bulkWriter.set(
        docRef,
        {
          participantId: participant.participantId,
          playerName: participant.playerName,
          adminNotes: preserveSeatLabel
            ? (existing as any)?.adminNotes ?? preserveSeatLabel
            : (participant.adminNotes ?? (existing as any)?.adminNotes ?? null),
          venueFeeName: participant.venueFeeName ?? (existing as any)?.venueFeeName ?? null,
          payment: {
            totalTransaction: participant.payment?.totalTransaction ?? 0,
            totalOwed: participant.payment?.totalOwed ?? 0,
            totalPaid: participant.payment?.totalPaid ?? 0,
          },
          checkedIn: preserveCheckedIn || Boolean(participant.checkedIn),
          checkedInAt: preserveCheckedIn ? preserveCheckedInAt : (participant.checkedIn ? FieldValue.serverTimestamp() : null),
          checkedInBy: preserveCheckedIn ? preserveCheckedInBy : null,
          seatLabel: preserveSeatLabel,
          importState: {
            lastImportJobId: importJobId,
            lastImportedAt: importedAtIso,
            seenInLatestImport: true,
            archived: Boolean((existing as any)?.importState?.archived),
          },
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      upsertCount += 1;
    }

    const missingParticipants: Array<{ participantId: string; playerName: string }> = [];
    for (const existingDoc of existingSnapshot.docs) {
      if (uploadedIds.has(existingDoc.id)) continue;
      const data = existingDoc.data() || {};

      missingParticipants.push({
        participantId: existingDoc.id,
        playerName: String(data.playerName || existingDoc.id).trim() || existingDoc.id,
      });

      bulkWriter.set(existingDoc.ref, {
        importState: {
          lastImportJobId: importJobId,
          lastImportedAt: importedAtIso,
          seenInLatestImport: false,
          archived: Boolean((data as any)?.importState?.archived),
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    await bulkWriter.close();

    return NextResponse.json({
      ok: true,
      importJobId,
      upsertCount,
      missingCount: missingParticipants.length,
      archivedCount: 0,
      skippedCount,
      missingParticipants,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "participants保存エラー" }, { status: 500 });
  }
}
