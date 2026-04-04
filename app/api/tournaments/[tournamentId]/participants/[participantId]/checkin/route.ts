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

function expandAlphabetRange(start: string, end: string): string[] {
  if (!start || !end) return [];
  const startCode = start.toUpperCase().charCodeAt(0);
  const endCode = end.toUpperCase().charCodeAt(0);
  const step = startCode <= endCode ? 1 : -1;
  const values: string[] = [];
  for (let code = startCode; step > 0 ? code <= endCode : code >= endCode; code += step) {
    values.push(String.fromCharCode(code));
  }
  return values;
}

function expandIntRange(start: number, end: number): string[] {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const step = start <= end ? 1 : -1;
  const values: string[] = [];
  for (let n = start; step > 0 ? n <= end : n >= end; n += step) {
    values.push(String(n));
  }
  return values;
}

function buildSeatLabels(pattern: string, totalCount: number): string[] {
  const tokenRegex = /\{(Alphabet|Int):([^{}:]+):([^{}:]+)\}|\{Count\}/g;
  const segments: Array<{ kind: "text"; value: string } | { kind: "values"; values: string[] }> = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(pattern)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", value: pattern.slice(lastIndex, match.index) });
    }
    if (match[0] === "{Count}") {
      segments.push({ kind: "text", value: String(totalCount) });
    } else {
      const values = match[1] === "Alphabet"
        ? expandAlphabetRange(String(match[2] || "").trim(), String(match[3] || "").trim())
        : expandIntRange(Number(match[2]), Number(match[3]));
      segments.push({ kind: "values", values });
    }
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < pattern.length) {
    segments.push({ kind: "text", value: pattern.slice(lastIndex) });
  }

  return segments.reduce<string[]>((acc, seg) => {
    if (seg.kind === "text") return acc.map((prefix) => `${prefix}${seg.value}`);
    if (!seg.values.length) return [];
    return acc.flatMap((prefix) => seg.values.map((value) => `${prefix}${value}`));
  }, [""]);
}

function toParticipantState(data: any) {
  return {
    participantId: String(data?.participantId || ""),
    playerName: String(data?.playerName || ""),
    adminNotes: String(data?.adminNotes || ""),
    seatLabel: String(data?.seatLabel || ""),
    checkedIn: Boolean(data?.checkedIn),
    checkedInAt: data?.checkedInAt || null,
    checkedInBy: data?.checkedInBy || null,
    venueFeeName: String(data?.venueFeeName || ""),
    payment: {
      totalTransaction: Number(data?.payment?.totalTransaction ?? 0),
      totalOwed: Number(data?.payment?.totalOwed ?? 0),
      totalPaid: Number(data?.payment?.totalPaid ?? 0),
    },
  };
}

async function claimSeatInTransaction({
  tx,
  seatsCol,
  participantId,
  preferredLabels,
  reservePrefix,
  assignmentType,
}: {
  tx: FirebaseFirestore.Transaction;
  seatsCol: FirebaseFirestore.CollectionReference;
  participantId: string;
  preferredLabels: string[];
  reservePrefix: string;
  assignmentType: "normal" | "reserve";
}) {
  for (const label of preferredLabels) {
    const seatRef = seatsCol.doc(label);
    const seatSnap = await tx.get(seatRef);
    const assigned = String(seatSnap.data()?.assignedParticipantId || "").trim();
    if (!assigned || assigned === participantId) {
      tx.set(seatRef, {
        seatLabel: label,
        assignedParticipantId: participantId,
        assignmentType,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return label;
    }
  }

  for (let i = 1; i <= 5000; i += 1) {
    const label = `${reservePrefix}-${i}`;
    const seatRef = seatsCol.doc(label);
    const seatSnap = await tx.get(seatRef);
    const assigned = String(seatSnap.data()?.assignedParticipantId || "").trim();
    if (!assigned || assigned === participantId) {
      tx.set(seatRef, {
        seatLabel: label,
        assignedParticipantId: participantId,
        assignmentType: "reserve",
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      return label;
    }
  }

  throw new Error("NO_AVAILABLE_SEAT");
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string; participantId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg", "operator_code"]);
  if (!authz.ok) return authz.response;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが空です" }, { status: 400 });
  }

  const reasonLabel = String(body.reasonLabel || "チェックイン").trim();
  const deltaAmount = Number(body.deltaAmount ?? 0);
  const requestId = typeof body.requestId === "string" ? body.requestId.trim().slice(0, 128) : "";

  const accessToken = request.cookies.get("startgg_access_token")?.value || "";
  const actor = getActorFromSession(authz.session);
  const actorDisplayName = authz.session.mode === "startgg" && accessToken
    ? await resolveOperatorUserId(accessToken, actor.actorDisplayName)
    : actor.actorDisplayName;

  try {
    const firestore = ensureFirestore();
    const tournamentRef = firestore.collection("tournaments").doc(params.tournamentId);
    const participantsCol = tournamentRef.collection("participants");
    const participantRef = participantsCol.doc(params.participantId);
    const seatsCol = tournamentRef.collection("seats");
    const auditCol = participantRef.collection("auditLogs");
    const idempotencyRef = requestId ? auditCol.doc(`req_${requestId}`) : null;

    let assignedSeat: string | null = null;
    let idempotent = false;

    await firestore.runTransaction(async (tx) => {
      if (idempotencyRef) {
        const idempotencySnap = await tx.get(idempotencyRef);
        if (idempotencySnap.exists) {
          idempotent = true;
          return;
        }
      }

      const participantSnap = await tx.get(participantRef);
      if (!participantSnap.exists) {
        throw new Error("NOT_FOUND");
      }

      const existing = participantSnap.data() || {};
      if (existing.checkedIn) {
        throw new Error("ALREADY_CHECKED_IN");
      }

      const before = toParticipantState({ participantId: params.participantId, ...existing });

      const tournamentSnap = await tx.get(tournamentRef);
      const config = tournamentSnap.data()?.seatAssignmentConfig?.autoOnCheckin;
      const autoEnabled = Boolean(config?.enabled);
      const participantVenueFeeName = String(existing.venueFeeName || "").trim();
      const targetVenueFees: string[] = Array.isArray(config?.venueFeeNames)
        ? config.venueFeeNames.map((v: any) => String(v || "").trim()).filter(Boolean)
        : [];
      const shouldAssignSeat = autoEnabled && targetVenueFees.includes(participantVenueFeeName);

      const payload: Record<string, unknown> = {
        checkedIn: true,
        checkedInAt: FieldValue.serverTimestamp(),
        checkedInBy: actorDisplayName,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (shouldAssignSeat && !String(existing.seatLabel || existing.adminNotes || "").trim()) {
        const reservePrefix = String(config?.reserveLabelPrefix || "予備台").trim() || "予備台";
        const exceptions = new Set(
          Array.isArray(config?.exceptionPlayerNames)
            ? config.exceptionPlayerNames.map((name: any) => String(name || "").trim()).filter(Boolean)
            : Array.isArray(config?.exceptionParticipantIds)
              ? config.exceptionParticipantIds.map((id: any) => String(id || "").trim()).filter(Boolean)
              : [],
        );

        const useReserve = exceptions.has(String(existing.playerName || "").trim()) || exceptions.has(params.participantId);
        if (useReserve) {
          assignedSeat = await claimSeatInTransaction({
            tx,
            seatsCol,
            participantId: params.participantId,
            preferredLabels: [],
            reservePrefix,
            assignmentType: "reserve",
          });
        } else {
          const labelCandidates = buildSeatLabels(String(config?.pattern || "{Alphabet:A:D}-{Int:1:4}"), 256);
          assignedSeat = await claimSeatInTransaction({
            tx,
            seatsCol,
            participantId: params.participantId,
            preferredLabels: labelCandidates,
            reservePrefix,
            assignmentType: "normal",
          });
        }

        payload.seatLabel = assignedSeat;
        payload.adminNotes = assignedSeat;
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
        type: "checkin",
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
    });

    if (idempotent) {
      return NextResponse.json({ ok: true, idempotent: true });
    }

    return NextResponse.json({ ok: true, assignedSeat });
  } catch (error: any) {
    if (error?.message === "NOT_FOUND") {
      return NextResponse.json({ error: "参加者が存在しません" }, { status: 404 });
    }
    if (error?.message === "ALREADY_CHECKED_IN") {
      return NextResponse.json({ error: "すでにチェックイン済みです", code: "ALREADY_CHECKED_IN" }, { status: 409 });
    }
    if (error?.message === "NO_AVAILABLE_SEAT") {
      return NextResponse.json({ error: "割り当て可能な座席がありません" }, { status: 409 });
    }
    return NextResponse.json({ error: error?.message ?? "チェックイン更新エラー" }, { status: 500 });
  }
}
