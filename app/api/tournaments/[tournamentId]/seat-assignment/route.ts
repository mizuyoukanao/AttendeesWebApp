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

type SeatAssignmentConfig = {
  bulk: SeatPatternConfig;
  autoOnCheckin: SeatPatternConfig & { enabled: boolean };
};

const defaultSeatPatternConfig: SeatPatternConfig = {
  venueFeeNames: [],
  pattern: "{Alphabet:A:D}-{Int:1:4}",
  exceptionParticipantIds: [],
  reserveLabelPrefix: "予備台",
};

const defaultSeatAssignmentConfig: SeatAssignmentConfig = {
  bulk: defaultSeatPatternConfig,
  autoOnCheckin: {
    ...defaultSeatPatternConfig,
    enabled: false,
  },
};

function ensureAuthenticated() {
  const accessToken = cookies().get("startgg_access_token")?.value;
  if (!accessToken) {
    return NextResponse.json({ error: "start.gg に未ログインです" }, { status: 401 });
  }
  return null;
}

function normalizePatternConfig(input: any): SeatPatternConfig {
  return {
    venueFeeNames: Array.isArray(input?.venueFeeNames)
      ? input.venueFeeNames.map((v: any) => String(v || "").trim()).filter(Boolean)
      : [],
    pattern: String(input?.pattern || defaultSeatPatternConfig.pattern).trim() || defaultSeatPatternConfig.pattern,
    exceptionParticipantIds: Array.isArray(input?.exceptionParticipantIds)
      ? input.exceptionParticipantIds.map((v: any) => String(v || "").trim()).filter(Boolean)
      : [],
    reserveLabelPrefix: String(input?.reserveLabelPrefix || defaultSeatPatternConfig.reserveLabelPrefix).trim() || defaultSeatPatternConfig.reserveLabelPrefix,
  };
}

function normalizeSeatAssignmentConfig(input: any): SeatAssignmentConfig {
  return {
    bulk: normalizePatternConfig(input?.bulk),
    autoOnCheckin: {
      ...normalizePatternConfig(input?.autoOnCheckin),
      enabled: Boolean(input?.autoOnCheckin?.enabled),
    },
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const unauthorized = ensureAuthenticated();
  if (unauthorized) return unauthorized;

  try {
    const firestore = ensureFirestore();
    const docRef = firestore.collection("tournaments").doc(params.tournamentId);
    const snap = await docRef.get();

    if (!snap.exists) {
      return NextResponse.json({ seatAssignmentConfig: defaultSeatAssignmentConfig, source: "default" });
    }

    const data = snap.data();
    const seatAssignmentConfig = data?.seatAssignmentConfig
      ? normalizeSeatAssignmentConfig(data.seatAssignmentConfig)
      : defaultSeatAssignmentConfig;

    return NextResponse.json({ seatAssignmentConfig, source: data?.seatAssignmentConfig ? "firestore" : "default" });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "seatAssignmentConfig取得エラー" }, { status: 500 });
  }
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

  const seatAssignmentConfig = normalizeSeatAssignmentConfig(body.seatAssignmentConfig ?? body);

  try {
    const firestore = ensureFirestore();
    const docRef = firestore.collection("tournaments").doc(params.tournamentId);

    await docRef.set(
      {
        seatAssignmentConfig,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json({ ok: true, seatAssignmentConfig });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "seatAssignmentConfig保存エラー" }, { status: 500 });
  }
}
