import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";

function formatTimestampJst(date: Date) {
  const offsetMs = 9 * 60 * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const yyyy = local.getUTCFullYear();
  const mm = `${local.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${local.getUTCDate()}`.padStart(2, "0");
  const hh = `${local.getUTCHours()}`.padStart(2, "0");
  const min = `${local.getUTCMinutes()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} JST`;
}

const GRAPHQL_URL = "https://api.start.gg/gql/alpha";

function ensureAuthenticated() {
  const accessToken = cookies().get("startgg_access_token")?.value;
  if (!accessToken) {
    return NextResponse.json({ error: "start.gg に未ログインです" }, { status: 401 });
  }
  return null;
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
  const unauthorized = ensureAuthenticated();
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => null);
  if (!body) {
    return NextResponse.json({ error: "リクエストボディが空です" }, { status: 400 });
  }

  const resetCheckIn = Boolean(body.resetCheckIn);
  const checkedIn = typeof body.checkedIn === "boolean" ? body.checkedIn : undefined;
  const adminNotes = typeof body.adminNotes === "string" ? body.adminNotes.trim() : undefined;
  const delta = Number(body.deltaAmount ?? 0);
  const reasonLabel = String(body.reasonLabel || "編集").trim();
  const requestedUserId = String(body.operatorUserId || "operator").trim();
  const accessToken = cookies().get("startgg_access_token")?.value || "";
  const operatorUserId = await resolveOperatorUserId(accessToken, requestedUserId);

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
    const now = new Date();
    const timestamp = formatTimestampJst(now);
    const logPrefix = resetCheckIn ? "未チェックインへ戻す" : "枠・金額編集";
    const noteEntry = `${timestamp} | ${logPrefix}: ${reasonLabel} | ${delta >= 0 ? `+${delta}` : delta}円`;

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
