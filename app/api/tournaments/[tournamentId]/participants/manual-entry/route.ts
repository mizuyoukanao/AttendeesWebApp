import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { getActorFromSession, requireTournamentAccess } from "@/lib/authz";

function normalizeAmount(value: unknown) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeVenueFeeNames(input: any): string[] {
  if (Array.isArray(input)) {
    return Array.from(new Set(input.map((v: any) => String(v || "").trim()).filter(Boolean)));
  }
  const raw = String(input || "").trim();
  if (!raw) return [];
  return Array.from(new Set(raw.split(/[,\n/／]+/).map((v) => v.trim()).filter(Boolean)));
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg", "operator_code"]);
  if (!authz.ok) return authz.response;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが空です" }, { status: 400 });
  }

  const playerName = String(body.playerName || "").trim();
  const venueFeeNames = normalizeVenueFeeNames(body.venueFeeNames ?? body.venueFeeName);
  const venueFeeName = venueFeeNames.join(" / ");
  const baseAmount = normalizeAmount(body.baseAmount);

  if (!playerName) {
    return NextResponse.json({ error: "参加者名は必須です" }, { status: 400 });
  }

  if (!venueFeeName) {
    return NextResponse.json({ error: "枠は必須です" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const tournamentRef = firestore.collection("tournaments").doc(params.tournamentId);
    const participantsCol = tournamentRef.collection("participants");
    const participantId = `manual_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const actor = getActorFromSession(authz.session);

    await participantsCol.doc(participantId).set(
      {
        participantId,
        playerName,
        venueFeeName,
        venueFeeNames,
        payment: {
          totalTransaction: 0,
          totalOwed: baseAmount,
          totalPaid: 0,
        },
        checkedIn: false,
        checkedInAt: null,
        checkedInBy: null,
        seatLabel: "",
        adminNotes: "",
        createdFrom: "manual_entry",
        createdBy: actor.actorDisplayName,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        adminLogEntries: [`[${new Date().toISOString()}] ${actor.actorDisplayName}: 手動追加エントリー (${venueFeeName})`],
      },
      { merge: false },
    );

    await tournamentRef.set({
      venueFeeCatalog: FieldValue.arrayUnion(...venueFeeNames),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return NextResponse.json({
      ok: true,
      participant: {
        participantId,
        playerName,
        venueFeeName,
        venueFeeNames,
        checkedIn: false,
        payment: {
          totalTransaction: 0,
          totalOwed: baseAmount,
          totalPaid: 0,
        },
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "手動参加者登録エラー" }, { status: 500 });
  }
}
