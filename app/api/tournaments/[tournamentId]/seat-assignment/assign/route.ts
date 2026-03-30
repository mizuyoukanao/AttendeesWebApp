import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";

type SeatPatternConfig = {
  venueFeeNames: string[];
  pattern: string;
  exceptionParticipantIds: string[];
  reserveLabelPrefix: string;
};

function ensureAuthenticated() {
  const accessToken = cookies().get("startgg_access_token")?.value;
  if (!accessToken) {
    return NextResponse.json({ error: "start.gg に未ログインです" }, { status: 401 });
  }
  return null;
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
    exceptionParticipantIds: Array.isArray(input?.exceptionParticipantIds)
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
  const unauthorized = ensureAuthenticated();
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディを解析できません" }, { status: 400 });
  }

  const config = normalizePatternConfig(body.config ?? body);
  const overwrite = Boolean(body.overwrite);

  if (!config.venueFeeNames.length) {
    return NextResponse.json({ error: "割り当て対象の枠が空です" }, { status: 400 });
  }

  try {
    const firestore = ensureFirestore();
    const participantsCol = firestore.collection("tournaments").doc(params.tournamentId).collection("participants");
    const participantsSnap = await participantsCol.orderBy("participantId").get();

    const allParticipants = participantsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
    const targets = allParticipants
      .filter((p) => config.venueFeeNames.includes(String(p.data.venueFeeName || "").trim()))
      .filter((p) => overwrite || !String(p.data.adminNotes || "").trim());

    const targetIds = new Set(targets.map((p) => p.id));
    const usedLabels = new Set(
      allParticipants
        .filter((p) => !targetIds.has(p.id))
        .map((p) => String(p.data.adminNotes || "").trim())
        .filter(Boolean),
    );

    const normalLabels = buildSeatLabels(config.pattern, targets.length);
    if (!normalLabels.length) {
      return NextResponse.json({ error: "台番号フォーマットから値を生成できませんでした" }, { status: 400 });
    }

    let normalIndex = 0;
    const exceptionIds = new Set(config.exceptionParticipantIds);
    const assignments: Array<{ participantId: string; label: string }> = [];

    for (const target of targets) {
      let label = "";
      if (!overwrite && String(target.data.adminNotes || "").trim()) {
        continue;
      }

      if (exceptionIds.has(target.id)) {
        label = nextReserveLabel(config.reserveLabelPrefix, usedLabels);
      } else {
        while (normalIndex < normalLabels.length && usedLabels.has(normalLabels[normalIndex])) {
          normalIndex += 1;
        }
        if (normalIndex < normalLabels.length) {
          label = normalLabels[normalIndex];
          normalIndex += 1;
        } else {
          label = nextReserveLabel(config.reserveLabelPrefix, usedLabels);
        }
      }

      usedLabels.add(label);
      assignments.push({ participantId: target.id, label });
    }

    const batch = firestore.batch();
    assignments.forEach(({ participantId, label }) => {
      const ref = participantsCol.doc(participantId);
      batch.set(ref, {
        adminNotes: label,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await batch.commit();

    return NextResponse.json({ ok: true, count: assignments.length, assignments });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "一括台番号割り当てエラー" }, { status: 500 });
  }
}
