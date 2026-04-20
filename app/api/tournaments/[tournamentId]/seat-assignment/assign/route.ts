import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { getActorFromSession, requireTournamentAccess } from "@/lib/authz";

type SeatPatternConfig = {
  venueFeeNames: string[];
  pattern: string;
  exceptionPlayerNames: string[];
  reserveLabelPrefix: string;
};

function normalizeVenueFeeNames(input: any): string[] {
  if (Array.isArray(input)) {
    return Array.from(new Set(input.map((v: any) => String(v || "").trim()).filter(Boolean)));
  }
  const raw = String(input || "").trim();
  if (!raw) return [];
  return Array.from(new Set(raw.split(/[,\n/／]+/).map((v) => v.trim()).filter(Boolean)));
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

function normalizePatternConfig(input: any): SeatPatternConfig {
  return {
    venueFeeNames: Array.isArray(input?.venueFeeNames)
      ? input.venueFeeNames.map((v: any) => String(v || "").trim()).filter(Boolean)
      : [],
    pattern: String(input?.pattern || "{Alphabet:A:D}-{Int:1:4}").trim() || "{Alphabet:A:D}-{Int:1:4}",
    exceptionPlayerNames: Array.isArray(input?.exceptionPlayerNames)
      ? input.exceptionPlayerNames.map((v: any) => String(v || "").trim()).filter(Boolean)
      : Array.isArray(input?.exceptionParticipantIds)
        ? input.exceptionParticipantIds.map((v: any) => String(v || "").trim()).filter(Boolean)
        : [],
    reserveLabelPrefix: String(input?.reserveLabelPrefix || "予備台").trim() || "予備台",
  };
}

function nextReserveLabel(prefix: string, used: Set<string>) {
  let i = 1;
  while (used.has(`${prefix}-${i}`)) i += 1;
  return `${prefix}-${i}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg"]);
  if (!authz.ok) return authz.response;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディを解析できません" }, { status: 400 });
  }

  const config = normalizePatternConfig(body.config ?? body);
  const overwrite = Boolean(body.overwrite);

  if (!config.venueFeeNames.length) {
    return NextResponse.json({ error: "割り当て対象の枠が空です" }, { status: 400 });
  }

  const firestore = ensureFirestore();
  const tournamentRef = firestore.collection("tournaments").doc(params.tournamentId);
  const participantsCol = tournamentRef.collection("participants");
  const seatsCol = tournamentRef.collection("seats");
  const lockRef = tournamentRef.collection("ops").doc("seat_assignment_lock");

  const nowMs = Date.now();
  const leaseMs = 2 * 60 * 1000;
  const requestId = typeof body.requestId === "string" && body.requestId.trim()
    ? body.requestId.trim().slice(0, 128)
    : `${nowMs}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    await firestore.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      const leaseUntil = Number(lockSnap.data()?.leaseUntilMs ?? 0);
      if (leaseUntil > nowMs) {
        throw new Error("LOCKED");
      }
      tx.set(lockRef, {
        leaseUntilMs: nowMs + leaseMs,
        requestId,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    const participantsSnap = await participantsCol.orderBy("participantId").get();
    const seatsSnap = await seatsCol.get();

    const allParticipants = participantsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    const seatMap = new Map(seatsSnap.docs.map((doc) => [doc.id, doc.data()]));

    const targets = allParticipants
      .filter((p) => normalizeVenueFeeNames(p.data.venueFeeNames ?? p.data.venueFeeName).some((name) => config.venueFeeNames.includes(name)));

    const normalLabels = buildSeatLabels(config.pattern, Math.max(targets.length, 1));
    if (!normalLabels.length) {
      return NextResponse.json({ error: "台番号フォーマットから値を生成できませんでした" }, { status: 400 });
    }

    const exceptionNames = new Set(config.exceptionPlayerNames);

    const usedLabels = new Set(
      Array.from(seatMap.entries())
        .filter(([, seat]) => String(seat?.assignedParticipantId || "").trim())
        .map(([label]) => label),
    );

    const assignments: Array<{ participantId: string; label: string; assignmentType: "normal" | "reserve"; prevLabel: string }> = [];
    let normalIndex = 0;

    for (const target of targets) {
      const prevLabel = String(target.data.seatLabel || target.data.adminNotes || "").trim();
      if (!overwrite && prevLabel) {
        usedLabels.add(prevLabel);
        continue;
      }

      let label = "";
      let assignmentType: "normal" | "reserve" = "normal";
      if (exceptionNames.has(String(target.data.playerName || "").trim())) {
        label = nextReserveLabel(config.reserveLabelPrefix, usedLabels);
        assignmentType = "reserve";
      } else {
        while (normalIndex < normalLabels.length && usedLabels.has(normalLabels[normalIndex])) {
          normalIndex += 1;
        }
        if (normalIndex < normalLabels.length) {
          label = normalLabels[normalIndex];
          normalIndex += 1;
        } else {
          label = nextReserveLabel(config.reserveLabelPrefix, usedLabels);
          assignmentType = "reserve";
        }
      }

      usedLabels.add(label);
      assignments.push({ participantId: target.id, label, assignmentType, prevLabel });
    }

    const actor = getActorFromSession(authz.session);
    const batch = firestore.batch();

    assignments.forEach(({ participantId, label, assignmentType, prevLabel }) => {
      const seatRef = seatsCol.doc(label);
      batch.set(seatRef, {
        seatLabel: label,
        assignedParticipantId: participantId,
        assignmentType,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      if (overwrite && prevLabel && prevLabel !== label) {
        const prevSeatRef = seatsCol.doc(prevLabel);
        batch.set(prevSeatRef, {
          seatLabel: prevLabel,
          assignedParticipantId: null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      const participantRef = participantsCol.doc(participantId);
      batch.set(participantRef, {
        seatLabel: label,
        adminNotes: label,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      const auditRef = participantRef.collection("auditLogs").doc();
      batch.set(auditRef, {
        type: "seat_assign",
        actorType: actor.actorType,
        actorId: actor.actorId,
        actorDisplayName: actor.actorDisplayName,
        reasonLabel: overwrite ? "bulk_assign_overwrite" : "bulk_assign",
        before: {
          seatLabel: prevLabel || null,
          adminNotes: prevLabel || null,
        },
        after: {
          seatLabel: label,
          adminNotes: label,
        },
        requestId,
        createdAt: FieldValue.serverTimestamp(),
      });
    });

    batch.set(lockRef, {
      leaseUntilMs: 0,
      releasedAt: FieldValue.serverTimestamp(),
      requestId,
    }, { merge: true });

    await batch.commit();

    return NextResponse.json({ ok: true, count: assignments.length, assignments });
  } catch (error: any) {
    if (error?.message === "LOCKED") {
      return NextResponse.json({ error: "座席割り当て処理が実行中です" }, { status: 409 });
    }

    try {
      await lockRef.set({ leaseUntilMs: 0, releasedAt: FieldValue.serverTimestamp(), requestId }, { merge: true });
    } catch {
      // noop
    }

    return NextResponse.json({ error: error?.message ?? "一括台番号割り当てエラー" }, { status: 500 });
  }
}
