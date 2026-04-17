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

type StreamPatchChange =
  | { type: "upsert"; participant: StreamParticipant }
  | { type: "remove"; participantId: string };

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
  const lastKnownParticipants = new Map<string, string>();
  let firstListenerSnapshot = true;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(serializeSse(event, payload)));
      };

      const sendPatch = (changes: StreamPatchChange[]) => {
        if (!changes.length) return;
        send("patch", { changes });
      };

      const sendSnapshot = async () => {
        const snap = await query.get();
        const participants = snap.docs.map((doc) => normalizeParticipant(doc.id, doc.data()));
        lastKnownParticipants.clear();
        participants.forEach((participant) => {
          lastKnownParticipants.set(participant.participantId, JSON.stringify(participant));
        });
        send("snapshot", { participants });
      };

      const fetchAndSendDiffPatch = async () => {
        const snap = await query.get();
        const nextParticipants = snap.docs.map((doc) => normalizeParticipant(doc.id, doc.data()));
        const nextMap = new Map<string, string>();
        const changes: StreamPatchChange[] = [];

        for (const participant of nextParticipants) {
          const serialized = JSON.stringify(participant);
          nextMap.set(participant.participantId, serialized);
          if (lastKnownParticipants.get(participant.participantId) !== serialized) {
            changes.push({ type: "upsert", participant });
          }
        }

        for (const participantId of Array.from(lastKnownParticipants.keys())) {
          if (!nextMap.has(participantId)) {
            changes.push({ type: "remove", participantId });
          }
        }

        lastKnownParticipants.clear();
        for (const [participantId, serialized] of Array.from(nextMap.entries())) {
          lastKnownParticipants.set(participantId, serialized);
        }

        sendPatch(changes);
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

      sendSnapshot().catch((error) => {
        send("error", { message: error?.message || "snapshot failed" });
      });

      try {
        unsubscribe = query.onSnapshot(
          (snap) => {
            if (pollingTimer) {
              clearInterval(pollingTimer);
              pollingTimer = null;
            }
            if (firstListenerSnapshot) {
              firstListenerSnapshot = false;
              return;
            }

            const changes: StreamPatchChange[] = [];
            for (const docChange of snap.docChanges()) {
              const participantId = docChange.doc.id;

              if (docChange.type === "removed") {
                if (lastKnownParticipants.has(participantId)) {
                  lastKnownParticipants.delete(participantId);
                  changes.push({ type: "remove", participantId });
                }
                continue;
              }

              const participant = normalizeParticipant(participantId, docChange.doc.data());
              const serialized = JSON.stringify(participant);
              if (lastKnownParticipants.get(participantId) === serialized) {
                continue;
              }
              lastKnownParticipants.set(participantId, serialized);
              changes.push({ type: "upsert", participant });
            }

            sendPatch(changes);
          },
          async () => {
            if (pollingTimer) return;
            pollingTimer = setInterval(() => {
              fetchAndSendDiffPatch().catch(() => {
                // noop
              });
            }, 1500);
          },
        );
      } catch {
        pollingTimer = setInterval(() => {
          fetchAndSendDiffPatch().catch(() => {
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
