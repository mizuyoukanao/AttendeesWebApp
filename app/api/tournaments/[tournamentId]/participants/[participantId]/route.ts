import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { getActorFromSession, requireTournamentAccess } from "@/lib/authz";

const GRAPHQL_URL = "https://api.start.gg/gql/alpha";

async function resolveOperatorUserId(accessToken: string, fallback: string) {
  try {
    const response = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        query: `query Viewer { currentUser { id player { gamerTag } } }`,
      }),
    });
    if (!response.ok) return fallback;
    const data = await response.json();
    return String(data?.data?.currentUser?.player?.gamerTag || data?.data?.currentUser?.id || fallback);
  } catch {
    return fallback;
  }
}

function toParticipantState(data: any) {
  return {
    participantId: String(data?.participantId || ""),
    playerName: String(data?.playerName || ""),
    adminNotes: String(data?.adminNotes || ""),
    checkedIn: Boolean(data?.checkedIn),
    checkedInAt: data?.checkedInAt || null,
    checkedInBy: data?.checkedInBy || null,
    venueFeeName: String(data?.venueFeeName || ""),
    payment: {
      totalTransaction: Number(data?.payment?.totalTransaction ?? 0),
      totalOwed: Number(data?.payment?.totalOwed ?? 0),
      totalPaid: Number(data?.payment?.totalPaid ?? 0),
    },
    seatLabel: String(data?.seatLabel || ""),
  };
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { tournamentId: string; participantId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg", "operator_code"]);
  if (!authz.ok) return authz.response;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが空です" }, { status: 400 });
  }

  const resetCheckIn = Boolean(body.resetCheckIn);
  const checkedIn = typeof body.checkedIn === "boolean" ? body.checkedIn : undefined;
  const adminNotes = typeof body.adminNotes === "string" ? body.adminNotes.trim() : undefined;
  const reasonLabel = String(body.reasonLabel || "編集").trim();
  const deltaAmount = Number(body.deltaAmount ?? 0);
  const requestId = typeof body.requestId === "string" ? body.requestId.trim().slice(0, 128) : "";
  const requestedUserId = String(body.operatorUserId || "").trim();

  const accessToken = request.cookies.get("startgg_access_token")?.value || "";
  const actor = getActorFromSession(authz.session);
  const actorDisplayName = authz.session.mode === "startgg" && accessToken
    ? await resolveOperatorUserId(accessToken, requestedUserId || actor.actorDisplayName)
    : (requestedUserId || actor.actorDisplayName);

  try {
    const firestore = ensureFirestore();
    const participantRef = firestore
      .collection("tournaments")
      .doc(params.tournamentId)
      .collection("participants")
      .doc(params.participantId);

    const auditCol = participantRef.collection("auditLogs");
    const idempotencyRef = requestId ? auditCol.doc(`req_${requestId}`) : null;

    let result: { ok: true; idempotent?: boolean } | null = null;

    await firestore.runTransaction(async (tx) => {
      if (idempotencyRef) {
        const idempotencySnap = await tx.get(idempotencyRef);
        if (idempotencySnap.exists) {
          result = { ok: true, idempotent: true };
          return;
        }
      }

      const snap = await tx.get(participantRef);
      if (!snap.exists) {
        throw new Error("NOT_FOUND");
      }

      const existing = snap.data() || {};
      const before = toParticipantState({ participantId: params.participantId, ...existing });

      const payload: Record<string, unknown> = {
        checkedInBy: actorDisplayName,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (adminNotes !== undefined) {
        payload.adminNotes = adminNotes;
      }
      if (resetCheckIn) {
        payload.checkedIn = false;
        payload.checkedInAt = null;
      } else if (checkedIn !== undefined) {
        payload.checkedIn = checkedIn;
        payload.checkedInAt = checkedIn ? FieldValue.serverTimestamp() : null;
      }

      tx.set(participantRef, payload, { merge: true });

      const next = {
        ...existing,
        ...payload,
        participantId: params.participantId,
      };
      const after = toParticipantState(next);

      const auditRef = idempotencyRef || auditCol.doc();
      tx.set(auditRef, {
        type: resetCheckIn ? "reset_checkin" : "edit",
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorDisplayName,
        reasonLabel,
        deltaAmount,
        before,
        after,
        requestId: requestId || null,
        createdAt: FieldValue.serverTimestamp(),
      });

      result = { ok: true };
    });

    return NextResponse.json(result || { ok: true });
  } catch (error: any) {
    if (error?.message === "NOT_FOUND") {
      return NextResponse.json({ error: "参加者が存在しません" }, { status: 404 });
    }
    return NextResponse.json({ error: error?.message ?? "参加者更新エラー" }, { status: 500 });
  }
}
