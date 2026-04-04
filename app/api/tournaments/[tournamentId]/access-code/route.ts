import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { requireTournamentAccess } from "@/lib/authz";
import { generateAccessCode, hashAccessCode, maskCode, normalizeAccessCode, timingSafeEqualHex } from "@/lib/accessCode";

type StoredAccessCode = {
  codeHash: string;
  status: "active" | "disabled" | "deleted";
  maskedCode?: string;
  createdAt: string;
  updatedAt: string;
};

async function generateUniqueAccessCode(firestore: ReturnType<typeof ensureFirestore>) {
  for (let i = 0; i < 30; i += 1) {
    const candidate = generateAccessCode();
    const candidateHash = hashAccessCode(candidate);
    const snap = await firestore.collection("operatorAccessCodes").doc(candidateHash).get();
    if (!snap.exists) return candidate;
  }
  throw new Error("コード生成に失敗しました");
}

function normalizeCodes(raw: any): StoredAccessCode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const legacyCode = normalizeAccessCode(String(item?.code || ""));
      const codeHash = String(item?.codeHash || (legacyCode ? hashAccessCode(legacyCode) : "")).trim();
      return {
        codeHash,
        status: item?.status === "disabled" || item?.status === "deleted" ? item.status : "active",
        maskedCode: String(item?.maskedCode || (legacyCode ? maskCode(legacyCode) : "")) || undefined,
        createdAt: String(item?.createdAt || ""),
        updatedAt: String(item?.updatedAt || item?.createdAt || ""),
      };
    })
    .filter((item) => item.codeHash);
}

function compareAgainstHistory(codes: StoredAccessCode[], candidateHash: string) {
  return codes.find((entry) => timingSafeEqualHex(entry.codeHash, candidateHash));
}

export async function GET(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const code = normalizeAccessCode(String(request.nextUrl.searchParams.get("code") || ""));

  try {
    const firestore = ensureFirestore();
    const snap = await firestore.collection("tournaments").doc(params.tournamentId).get();
    const data = snap.data() || {};
    const codes = normalizeCodes(data.operatorAccessCodeHistory);

    if (code) {
      const candidateHash = hashAccessCode(code);
      const matched = compareAgainstHistory(codes, candidateHash);
      const activeHash = String(data.operatorAccessCodeHash || "").trim();
      const valid = matched
        ? matched.status === "active"
        : Boolean(activeHash && timingSafeEqualHex(activeHash, candidateHash));
      return NextResponse.json({ valid });
    }

    const authz = requireTournamentAccess(request, params.tournamentId, ["startgg"]);
    if (!authz.ok) return authz.response;

    return NextResponse.json({
      accessCode: null,
      history: codes,
      activeCodeHash: String(data.operatorAccessCodeHash || "") || null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "大会コード取得エラー" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg"]);
  if (!authz.ok) return authz.response;
  const body = await request.json().catch(() => null);
  const tournamentName = typeof body?.name === "string" ? body.name.trim() : "";

  try {
    const firestore = ensureFirestore();
    const code = await generateUniqueAccessCode(firestore);
    const codeHash = hashAccessCode(code);
    const maskedCode = maskCode(code);
    const now = new Date().toISOString();
    const ref = firestore.collection("tournaments").doc(params.tournamentId);

    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() || {};
      const previousActiveHashes: string[] = [];
      const codes = normalizeCodes(data.operatorAccessCodeHistory).map((item) => {
        if (item.status === "active") {
          previousActiveHashes.push(item.codeHash);
          return { ...item, status: "disabled" as const, updatedAt: now };
        }
        return item;
      });

      codes.unshift({
        codeHash,
        maskedCode,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      tx.set(ref, {
        operatorAccessCodeHash: codeHash,
        operatorAccessCodeHistory: codes,
        name: tournamentName || data?.name || null,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      previousActiveHashes.forEach((hash) => {
        tx.set(firestore.collection("operatorAccessCodes").doc(hash), {
          status: "disabled",
          updatedAt: now,
        }, { merge: true });
      });

      tx.set(firestore.collection("operatorAccessCodes").doc(codeHash), {
        codeHash,
        tournamentId: params.tournamentId,
        tournamentName: tournamentName || data?.name || null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
    });

    return NextResponse.json({ ok: true, accessCode: code, codeHash, maskedCode });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "大会コード発行エラー" }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg"]);
  if (!authz.ok) return authz.response;

  const body = await request.json().catch(() => null);
  const action = String(body?.action || "").trim();
  const targetCodeHash = String(body?.codeHash || body?.code || "").trim();
  if (!action || !targetCodeHash) {
    return NextResponse.json({ error: "action と codeHash が必要です" }, { status: 400 });
  }

  try {
    const now = new Date().toISOString();
    const firestore = ensureFirestore();
    const ref = firestore.collection("tournaments").doc(params.tournamentId);

    await firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() || {};
      const codes = normalizeCodes(data.operatorAccessCodeHistory);
      const idx = codes.findIndex((item) => timingSafeEqualHex(item.codeHash, targetCodeHash));
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

      const activeCodeHash = codes.find((item) => item.status === "active")?.codeHash || null;
      tx.set(ref, {
        operatorAccessCodeHash: activeCodeHash,
        operatorAccessCodeHistory: codes,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(firestore.collection("operatorAccessCodes").doc(targetCodeHash), {
        codeHash: targetCodeHash,
        status: codes[idx].status,
        tournamentId: params.tournamentId,
        updatedAt: now,
      }, { merge: true });

      if (action === "activate") {
        codes.forEach((item) => {
          if (!timingSafeEqualHex(item.codeHash, targetCodeHash) && item.status === "disabled") {
            tx.set(firestore.collection("operatorAccessCodes").doc(item.codeHash), {
              codeHash: item.codeHash,
              status: "disabled",
              tournamentId: params.tournamentId,
              updatedAt: now,
            }, { merge: true });
          }
        });
      }
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
