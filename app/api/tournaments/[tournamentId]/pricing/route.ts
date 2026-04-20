import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { requireTournamentAccess } from "@/lib/authz";

type AdjustmentOption = {
  key: string;
  label: string;
  deltaAmount: number;
  requiresReason: boolean;
};

type PricingConfig = {
  generalFee: number;
  bringConsoleFee: number;
  studentFixedFee: number;
  adjustmentOptions: AdjustmentOption[];
  feeProfiles?: Array<{
    key: string;
    label: string;
    venueFeeName: string;
    amount: number;
  }>;
};

const defaultPricingConfig: PricingConfig = {
  generalFee: 4000,
  bringConsoleFee: 3000,
  studentFixedFee: 1000,
  adjustmentOptions: [
    { key: "none", label: "変更なし", deltaAmount: 0, requiresReason: false },
    { key: "general_to_bring", label: "一般→持参 (-1000円)", deltaAmount: -1000, requiresReason: false },
    { key: "bring_to_general", label: "持参→一般 (+1000円)", deltaAmount: 1000, requiresReason: false },
    { key: "student_general", label: "学割（一般）(-3000円)", deltaAmount: -3000, requiresReason: false },
    { key: "student_bring", label: "学割（持参）(-2000円)", deltaAmount: -2000, requiresReason: false },
    { key: "other", label: "その他（理由と金額を入力）", deltaAmount: 0, requiresReason: true },
  ],
  feeProfiles: [
    { key: "general", label: "一般", venueFeeName: "一般枠", amount: 4000 },
    { key: "bring", label: "持参", venueFeeName: "持参枠", amount: 3000 },
    { key: "student", label: "学割", venueFeeName: "学割枠", amount: 1000 },
  ],
};

function normalizeAdjustment(input: any): AdjustmentOption {
  return {
    key: String(input.key || ""),
    label: String(input.label || ""),
    deltaAmount: Number(input.deltaAmount || 0),
    requiresReason: Boolean(input.requiresReason),
  };
}

function normalizePricingConfig(input: any): PricingConfig {
  const adjustmentOptions = Array.isArray(input?.adjustmentOptions)
    ? input.adjustmentOptions.map(normalizeAdjustment).filter((opt: AdjustmentOption) => opt.key && opt.label)
    : defaultPricingConfig.adjustmentOptions;

  return {
    generalFee: Number(input?.generalFee ?? defaultPricingConfig.generalFee),
    bringConsoleFee: Number(input?.bringConsoleFee ?? defaultPricingConfig.bringConsoleFee),
    studentFixedFee: Number(input?.studentFixedFee ?? defaultPricingConfig.studentFixedFee),
    adjustmentOptions,
    feeProfiles: Array.isArray(input?.feeProfiles)
      ? input.feeProfiles.map((item: any, idx: number) => ({
        key: String(item?.key || `profile_${idx + 1}`).trim() || `profile_${idx + 1}`,
        label: String(item?.label || "").trim() || `料金${idx + 1}`,
        venueFeeName: String(item?.venueFeeName || "").trim() || "一般枠",
        amount: Number(item?.amount ?? 0),
      }))
      : defaultPricingConfig.feeProfiles,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg", "operator_code"]);
  if (!authz.ok) return authz.response;

  try {
    const firestore = ensureFirestore();
    const docRef = firestore.collection("tournaments").doc(params.tournamentId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return NextResponse.json({ pricingConfig: defaultPricingConfig, source: "default" });
    }

    const data = snap.data();
    const pricingConfig = data?.pricingConfig ? normalizePricingConfig(data.pricingConfig) : defaultPricingConfig;
    return NextResponse.json({ pricingConfig, source: "firestore", name: data?.name || null });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "pricingConfig取得エラー" }, { status: 500 });
  }
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

  const pricingConfig = normalizePricingConfig(body.pricingConfig ?? body);

  try {
    const firestore = ensureFirestore();
    const docRef = firestore.collection("tournaments").doc(params.tournamentId);

    await docRef.set(
      {
        pricingConfig,
        name: body.name || null,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json({ ok: true, pricingConfig });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "pricingConfig保存エラー" }, { status: 500 });
  }
}
