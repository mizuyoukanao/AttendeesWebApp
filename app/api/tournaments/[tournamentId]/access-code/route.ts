import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";

type StoredAccessCode = {
  code: string;
  status: "active" | "disabled" | "deleted";
  createdAt: string;
  updatedAt: string;
};

function ensureAuthenticated() {
  const accessToken = cookies().get("startgg_access_token")?.value;
  if (!accessToken) {
    return NextResponse.json({ error: "start.gg に未ログインです" }, { status: 401 });
  }
  return null;
}

function generateAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const block = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${block()}-${block()}`;
}

function normalizeCodes(raw: any): StoredAccessCode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => ({
      code: String(item?.code || "").trim(),
      status: item?.status === "disabled" || item?.status === "deleted" ? item.status : "active",
      createdAt: String(item?.createdAt || ""),
      updatedAt: String(item?.updatedAt || item?.createdAt || ""),
    }))
    .filter((item) => item.code);
}

export async function GET(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const code = request.nextUrl.searchParams.get("code");

  try {
    const firestore = ensureFirestore();
    const snap = await firestore.collection("tournaments").doc(params.tournamentId).get();
    const data = snap.data() || {};
    const codes = normalizeCodes(data.operatorAccessCodeHistory);
    const activeCode = codes.find((entry) => entry.status === "active")?.code
      || String(data.operatorAccessCode || "").trim();

    if (code) {
      const matched = codes.find((entry) => entry.code === code.trim());
      const valid = matched ? matched.status === "active" : Boolean(activeCode && activeCode === code.trim());
      return NextResponse.json({ valid });
    }

    const unauthorized = ensureAuthenticated();
    if (unauthorized) return unauthorized;
    return NextResponse.json({ accessCode: activeCode || null, history: codes });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "大会コード取得エラー" }, { status: 500 });
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const unauthorized = ensureAuthenticated();
  if (unauthorized) return unauthorized;

  try {
    const code = generateAccessCode();
    const now = new Date().toISOString();
    const firestore = ensureFirestore();
    const ref = firestore.collection("tournaments").doc(params.tournamentId);
    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() || {};
      const codes = normalizeCodes(data.operatorAccessCodeHistory).map((item) =>
        item.status === "active" ? { ...item, status: "disabled" as const, updatedAt: now } : item);
      codes.unshift({
        code,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      tx.set(ref, {
        operatorAccessCode: code,
        operatorAccessCodeHistory: codes,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    return NextResponse.json({ ok: true, accessCode: code });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "大会コード発行エラー" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const unauthorized = ensureAuthenticated();
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => null);
  const action = String(body?.action || "").trim();
  const targetCode = String(body?.code || "").trim();
  if (!action || !targetCode) {
    return NextResponse.json({ error: "action と code が必要です" }, { status: 400 });
  }

  try {
    const now = new Date().toISOString();
    const firestore = ensureFirestore();
    const ref = firestore.collection("tournaments").doc(params.tournamentId);

    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() || {};
      const codes = normalizeCodes(data.operatorAccessCodeHistory);
      const idx = codes.findIndex((item) => item.code === targetCode);
      if (idx < 0) throw new Error("NOT_FOUND");

      if (action === "disable") {
        codes[idx] = { ...codes[idx], status: "disabled", updatedAt: now };
      } else if (action === "delete") {
        codes[idx] = { ...codes[idx], status: "deleted", updatedAt: now };
      } else if (action === "activate") {
        for (let i = 0; i < codes.length; i += 1) {
          if (codes[i].status === "active") codes[i] = { ...codes[i], status: "disabled", updatedAt: now };
        }
        codes[idx] = { ...codes[idx], status: "active", updatedAt: now };
      } else {
        throw new Error("BAD_ACTION");
      }

      const activeCode = codes.find((item) => item.status === "active")?.code || null;
      tx.set(ref, {
        operatorAccessCode: activeCode,
        operatorAccessCodeHistory: codes,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    if (error?.message === "NOT_FOUND") {
      return NextResponse.json({ error: "対象コードが見つかりません" }, { status: 404 });
    }
    if (error?.message === "BAD_ACTION") {
      return NextResponse.json({ error: "不正な action です" }, { status: 400 });
    }
    return NextResponse.json({ error: error?.message ?? "大会コード更新エラー" }, { status: 500 });
  }
}
