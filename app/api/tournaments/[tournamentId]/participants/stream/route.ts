import { NextRequest, NextResponse } from "next/server";
import { ensureFirestore } from "@/lib/firebaseAdmin";
import { requireTournamentAccess } from "@/lib/authz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type StreamParticipant = {
  participantId: string;
  playerName: string;
  adminNotes?: string;
  venueFeeName?: string;
  payment: {
    totalTransaction: number;
    totalOwed: number;
    totalPaid?: number;
  };
  checkedIn: boolean;
  checkedInAt?: string;
  checkedInBy?: string;
  seatLabel?: string;
};

function serializeSse(event: string, payload: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function normalizeParticipant(id: string, raw: any): StreamParticipant {
  return {
    participantId: id,
    playerName: String(raw?.playerName || id),
    adminNotes: String(raw?.adminNotes || "") || "",
    venueFeeName: String(raw?.venueFeeName || "") || "",
    payment: {
      totalTransaction: Number(raw?.payment?.totalTransaction ?? 0),
      totalOwed: Number(raw?.payment?.totalOwed ?? 0),
      totalPaid: Number(raw?.payment?.totalPaid ?? 0),
    },
    checkedIn: Boolean(raw?.checkedIn),
    checkedInAt: raw?.checkedInAt?.toDate ? raw.checkedInAt.toDate().toISOString() : raw?.checkedInAt || undefined,
    checkedInBy: raw?.checkedInBy || undefined,
    seatLabel: String(raw?.seatLabel || ""),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { tournamentId: string } },
) {
  const authz = requireTournamentAccess(request, params.tournamentId, ["startgg", "operator_code"]);
  if (!authz.ok) return authz.response;

  const firestore = ensureFirestore();
  const query = firestore
    .collection("tournaments")
    .doc(params.tournamentId)
    .collection("participants")
    .orderBy("participantId");

  const encoder = new TextEncoder();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let pollingTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let lastSerialized = "";

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(serializeSse(event, payload)));
      };

      const sendSnapshot = async (event: "snapshot" | "update") => {
        const snap = await query.get();
        const participants = snap.docs.map((doc) => normalizeParticipant(doc.id, doc.data()));
        const serialized = JSON.stringify(participants);
        if (event === "update" && serialized === lastSerialized) return;
        lastSerialized = serialized;
        send(event, { participants });
      };

      const closeAll = () => {
        if (closed) return;
        closed = true;
        if (unsubscribe) unsubscribe();
        if (pollingTimer) clearInterval(pollingTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try {
          controller.close();
        } catch {
          // noop
        }
      };

      request.signal.addEventListener("abort", closeAll);

      heartbeatTimer = setInterval(() => {
        send("heartbeat", { ts: Date.now() });
      }, 20_000);

      sendSnapshot("snapshot").catch((error) => {
        send("error", { message: error?.message || "snapshot failed" });
      });

      try {
        unsubscribe = query.onSnapshot(
          (snap) => {
            const participants = snap.docs.map((doc) => normalizeParticipant(doc.id, doc.data()));
            const serialized = JSON.stringify(participants);
            if (serialized === lastSerialized) return;
            lastSerialized = serialized;
            send("update", { participants });
          },
          async () => {
            if (pollingTimer) return;
            pollingTimer = setInterval(() => {
              sendSnapshot("update").catch(() => {
                // noop
              });
            }, 1500);
          },
        );
      } catch {
        pollingTimer = setInterval(() => {
          sendSnapshot("update").catch(() => {
            // noop
          });
        }, 1500);
      }
    },
    cancel() {
      closed = true;
      if (unsubscribe) unsubscribe();
      if (pollingTimer) clearInterval(pollingTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
