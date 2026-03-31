import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { ensureFirestore } from "@/lib/firebaseAdmin";

export type OperatorAccessResult = {
  accessToken: string;
  operatorHandle: string;
};

export async function ensureOperatorAccess(request: NextRequest, tournamentId: string) {
  const accessToken = cookies().get("startgg_access_token")?.value || "";
  if (accessToken) {
    return { ok: true as const, result: { accessToken, operatorHandle: "" } satisfies OperatorAccessResult };
  }

  const code = String(request.headers.get("x-tournament-access-code") || "").trim();
  const operatorHandle = String(request.headers.get("x-operator-handle") || "").trim() || "code-operator";
  if (!code) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "start.ggログインまたは大会コード認証が必要です" }, { status: 401 }),
    };
  }

  const firestore = ensureFirestore();
  const snap = await firestore.collection("tournaments").doc(tournamentId).get();
  const data = snap.data() || {};
  const history = Array.isArray(data.operatorAccessCodeHistory) ? data.operatorAccessCodeHistory : [];
  const matched = history.find((item: any) => String(item?.code || "").trim() === code);
  const expected = String(data.operatorAccessCode || "").trim();
  const isValid = matched ? matched?.status === "active" : Boolean(expected && expected === code);
  if (!isValid) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "大会コードが無効です" }, { status: 401 }),
    };
  }

  return { ok: true as const, result: { accessToken: "", operatorHandle } satisfies OperatorAccessResult };
}
