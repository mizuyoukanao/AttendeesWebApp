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
export async function PATCH(
  request: NextRequest,
  { params }: { params: { tournamentId: string; participantId: string } },
) {
  const access = await ensureOperatorAccess(request, params.tournamentId);
  if (!access.ok) return access.response;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが空です" }, { status: 400 });
  }

  const resetCheckIn = Boolean(body.resetCheckIn);
  const checkedIn = typeof body.checkedIn === "boolean" ? body.checkedIn : undefined;
  const adminNotes = typeof body.adminNotes === "string" ? body.adminNotes.trim() : undefined;
  const reasonLabel = String(body.reasonLabel || "編集").trim();
  const requiresReason = Boolean(body.requiresReason);
  const deltaAmount = Number(body.deltaAmount ?? 0);
  const requestedUserId = String(body.operatorUserId || "operator").trim();
  const operatorUserId = access.result.accessToken
    ? await resolveOperatorUserId(access.result.accessToken, requestedUserId)
    : (requestedUserId || access.result.operatorHandle);

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
    const logPrefix = resetCheckIn ? "未チェックインへ戻す" : "枠・金額編集";
    const label = `${logPrefix}: ${reasonLabel}`;
    const noteEntry = buildEditNote(label, operatorUserId, requiresReason, deltaAmount);

    const payload: Record<string, unknown> = {
      checkedInBy: operatorUserId,
      editNotes: existing.editNotes ? `${existing.editNotes}\n${noteEntry}` : noteEntry,
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

    await docRef.set(payload, { merge: true });
    return NextResponse.json({ ok: true, noteEntry });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "参加者更新エラー" }, { status: 500 });
  }
}
