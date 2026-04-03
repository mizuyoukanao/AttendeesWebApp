import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { ensureOperatorAccess } from "@/lib/operatorAccess";

const GRAPHQL_URL = "https://api.start.gg/gql/alpha";

function buildEditNote(reasonLabel: string, operatorUserId: string, requiresReason: boolean, deltaAmount: number) {
  const label = reasonLabel.trim() || "変更なし";
  const operator = operatorUserId.trim() || "operator";
  if (requiresReason) {
    const signedDelta = deltaAmount >= 0 ? `+${deltaAmount}` : `${deltaAmount}`;
    return `${label} | ${signedDelta}円 | 受付: ${operator}`;
  }
  return `${label} | 受付: ${operator}`;
}

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

function nextReserveLabel(prefix: string, used: Set<string>) {
  let i = 1;
  while (used.has(`${prefix}-${i}`)) i += 1;
  return `${prefix}-${i}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string; participantId: string } },
) {
  const access = await ensureOperatorAccess(request, params.tournamentId);
  if (!access.ok) return access.response;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが空です" }, { status: 400 });
  }

  const reasonLabel = String(body.reasonLabel || "").trim();
  const requiresReason = Boolean(body.requiresReason);
  const deltaAmount = Number(body.deltaAmount ?? 0);
  const requestedUserId = String(body.operatorUserId || "operator").trim();
  const operatorUserId = access.result.accessToken
    ? await resolveOperatorUserId(access.result.accessToken, requestedUserId)
    : (requestedUserId || access.result.operatorHandle);

  try {
    const firestore = ensureFirestore();
    const label = reasonLabel || "チェックイン";
    const noteEntry = buildEditNote(label, operatorUserId, requiresReason, deltaAmount);
    const tournamentRef = firestore.collection("tournaments").doc(params.tournamentId);
    const participantsCol = tournamentRef.collection("participants");
    const docRef = participantsCol.doc(params.participantId);
    let assignedSeat: string | null = null;

    await firestore.runTransaction(async (tx) => {
      const participantSnap = await tx.get(docRef);
      if (!participantSnap.exists) {
        throw new Error("NOT_FOUND");
      }
      const existing = participantSnap.data() || {};
      if (existing.checkedIn) {
        throw new Error("ALREADY_CHECKED_IN");
      }

      const tournamentSnap = await tx.get(tournamentRef);
      const config = tournamentSnap.data()?.seatAssignmentConfig?.autoOnCheckin;
      const autoEnabled = Boolean(config?.enabled);
      const participantVenueFeeName = String(existing.venueFeeName || "").trim();
      const targetVenueFees: string[] = Array.isArray(config?.venueFeeNames)
        ? config.venueFeeNames.map((v: any) => String(v || "").trim()).filter(Boolean)
        : [];
      const shouldAssignSeat = autoEnabled && targetVenueFees.includes(participantVenueFeeName);
      let autoSeatLabel: string | null = null;

      if (shouldAssignSeat && !String(existing.adminNotes || "").trim()) {
        const allSnap = await tx.get(participantsCol);
        const used = new Set(
          allSnap.docs
            .map((doc) => String(doc.data()?.adminNotes || "").trim())
            .filter(Boolean),
        );
        const exceptions = new Set(
          Array.isArray(config?.exceptionPlayerNames)
            ? config.exceptionPlayerNames.map((name: any) => String(name || "").trim()).filter(Boolean)
            : Array.isArray(config?.exceptionParticipantIds)
              ? config.exceptionParticipantIds.map((id: any) => String(id || "").trim()).filter(Boolean)
              : [],
        );
        const reservePrefix = String(config?.reserveLabelPrefix || "予備台").trim() || "予備台";
        const normalLabels = buildSeatLabels(String(config?.pattern || "{Alphabet:A:D}-{Int:1:4}"), allSnap.size + 1);
        if (!normalLabels.length) {
          autoSeatLabel = nextReserveLabel(reservePrefix, used);
        } else if (exceptions.has(String(existing.playerName || "").trim()) || exceptions.has(params.participantId)) {
          autoSeatLabel = nextReserveLabel(reservePrefix, used);
        } else {
          autoSeatLabel = normalLabels.find((label) => !used.has(label)) || nextReserveLabel(reservePrefix, used);
        }
      }

      const payload: Record<string, unknown> = {
        checkedIn: true,
        checkedInAt: FieldValue.serverTimestamp(),
        checkedInBy: operatorUserId,
        editNotes: existing.editNotes ? `${existing.editNotes}\n${noteEntry}` : noteEntry,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (autoSeatLabel) {
        payload.adminNotes = autoSeatLabel;
        assignedSeat = autoSeatLabel;
      }
      tx.set(docRef, payload, { merge: true });
    });

    return NextResponse.json({ ok: true, noteEntry, assignedSeat });
  } catch (error: any) {
    if (error?.message === "NOT_FOUND") {
      return NextResponse.json({ error: "参加者が存在しません" }, { status: 404 });
    }
    if (error?.message === "ALREADY_CHECKED_IN") {
      return NextResponse.json({ error: "すでにチェックイン済みです" }, { status: 400 });
    }
    return NextResponse.json({ error: error?.message ?? "チェックイン更新エラー" }, { status: 500 });
  }
}
