import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";

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
    ? input.adjustmentOptions.map(normalizeAdjustment).filter((opt) => opt.key && opt.label)
    : defaultPricingConfig.adjustmentOptions;

  return {
    generalFee: Number(input?.generalFee ?? defaultPricingConfig.generalFee),
    bringConsoleFee: Number(input?.bringConsoleFee ?? defaultPricingConfig.bringConsoleFee),
    studentFixedFee: Number(input?.studentFixedFee ?? defaultPricingConfig.studentFixedFee),
    adjustmentOptions,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
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
