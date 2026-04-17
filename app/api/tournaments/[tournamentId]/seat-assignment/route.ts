import { NextRequest, NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { requireTournamentAccess } from "@/lib/authz";

type SeatPatternConfig = {
  venueFeeNames: string[];
  pattern: string;
  exceptionPlayerNames: string[];
  reserveLabelPrefix: string;
};

type SeatAssignmentConfig = {
  bulk: SeatPatternConfig;
  autoOnCheckin: SeatPatternConfig & { enabled: boolean };
};

const defaultSeatPatternConfig: SeatPatternConfig = {
  venueFeeNames: [],
  pattern: "{Alphabet:A:D}-{Int:1:4}",
  exceptionPlayerNames: [],
  reserveLabelPrefix: "予備台",
};

const defaultSeatAssignmentConfig: SeatAssignmentConfig = {
  bulk: defaultSeatPatternConfig,
  autoOnCheckin: {
    ...defaultSeatPatternConfig,
    enabled: false,
  },
};

function normalizePatternConfig(input: any): SeatPatternConfig {
  return {
    venueFeeNames: Array.isArray(input?.venueFeeNames)
      ? input.venueFeeNames.map((v: any) => String(v || "").trim()).filter(Boolean)
      : [],
    pattern: String(input?.pattern || defaultSeatPatternConfig.pattern).trim() || defaultSeatPatternConfig.pattern,
    exceptionPlayerNames: Array.isArray(input?.exceptionPlayerNames)
      ? input.exceptionPlayerNames.map((v: any) => String(v || "").trim()).filter(Boolean)
      : Array.isArray(input?.exceptionParticipantIds)
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

function normalizeVenueFeeCatalog(input: any): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((v: any) => String(v || "").trim()).filter(Boolean)));
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
      return NextResponse.json({ seatAssignmentConfig: defaultSeatAssignmentConfig, source: "default" });
    }

    const data = snap.data();
    const seatAssignmentConfig = data?.seatAssignmentConfig
      ? normalizeSeatAssignmentConfig(data.seatAssignmentConfig)
      : defaultSeatAssignmentConfig;

    const venueFeeCatalog = normalizeVenueFeeCatalog(data?.venueFeeCatalog);
    return NextResponse.json({
      seatAssignmentConfig,
      venueFeeCatalog,
      source: data?.seatAssignmentConfig ? "firestore" : "default",
    });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "seatAssignmentConfig取得エラー" }, { status: 500 });
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

  const seatAssignmentConfig = normalizeSeatAssignmentConfig(body.seatAssignmentConfig ?? body);
  const venueFeeCatalog = normalizeVenueFeeCatalog(body.venueFeeCatalog);

  try {
    const firestore = ensureFirestore();
    const docRef = firestore.collection("tournaments").doc(params.tournamentId);

    await docRef.set(
      {
        seatAssignmentConfig,
        venueFeeCatalog,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return NextResponse.json({ ok: true, seatAssignmentConfig });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message ?? "seatAssignmentConfig保存エラー" }, { status: 500 });
  }
}
