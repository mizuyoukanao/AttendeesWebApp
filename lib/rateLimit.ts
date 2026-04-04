import crypto from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { ensureFirestore } from "@/lib/firebaseAdmin";

function hashValue(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function getRequestIp(headers: Headers) {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const realIp = headers.get("x-real-ip")?.trim();
  return forwarded || realIp || "unknown";
}

export async function checkRateLimit(input: {
  namespace: string;
  ip: string;
  limit: number;
  windowSeconds: number;
}) {
  const now = Date.now();
  const windowMs = input.windowSeconds * 1000;
  const bucketStartMs = Math.floor(now / windowMs) * windowMs;
  const bucketStart = Timestamp.fromMillis(bucketStartMs);
  const expiresAt = Timestamp.fromMillis(bucketStartMs + windowMs * 2);
  const ipHash = hashValue(input.ip || "unknown");
  const bucketKey = `${input.namespace}:${ipHash}:${bucketStartMs}`;
  const firestore = ensureFirestore();
  const ref = firestore.collection("rateLimits").doc(bucketKey);

  let allowed = false;
  let count = 0;

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = Number(snap.data()?.count ?? 0);
    const next = current + 1;
    count = next;

    tx.set(ref, {
      key: bucketKey,
      namespace: input.namespace,
      ipHash,
      count: next,
      windowStartedAt: bucketStart,
      expiresAt,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    allowed = next <= input.limit;
  });

  const retryAfterSeconds = Math.max(1, Math.ceil((bucketStartMs + windowMs - now) / 1000));
  return {
    allowed,
    count,
    limit: input.limit,
    retryAfterSeconds,
  };
}
