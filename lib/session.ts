import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";

export type SessionMode = "startgg" | "operator_code";

export type AppSession = {
  mode: SessionMode;
  userId: string;
  displayName: string;
  allowedTournamentIds: string[];
  exp: number;
};

export const APP_SESSION_COOKIE = "app_session";

const SESSION_TTL_SECONDS = 60 * 60 * 8;
const OPERATOR_SESSION_TTL_SECONDS = 60 * 60 * 4;

function getSessionSecret() {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) throw new Error("APP_SESSION_SECRET が未設定です");
  return secret;
}

function toBase64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf-8");
}

function sign(payloadB64: string) {
  return crypto.createHmac("sha256", getSessionSecret()).update(payloadB64).digest("base64url");
}

export function createSignedSession(payload: Omit<AppSession, "exp"> & { exp?: number }): string {
  const normalized: AppSession = {
    ...payload,
    userId: String(payload.userId || "").trim(),
    displayName: String(payload.displayName || "").trim() || "operator",
    allowedTournamentIds: Array.from(new Set((payload.allowedTournamentIds || []).map((id) => String(id).trim()).filter(Boolean))),
    exp: payload.exp ?? Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };

  const payloadB64 = toBase64Url(JSON.stringify(normalized));
  const signature = sign(payloadB64);
  return `${payloadB64}.${signature}`;
}

export function createOperatorSignedSession(payload: {
  userId: string;
  displayName: string;
  tournamentId: string;
}): string {
  return createSignedSession({
    mode: "operator_code",
    userId: payload.userId,
    displayName: payload.displayName,
    allowedTournamentIds: [payload.tournamentId],
    exp: Math.floor(Date.now() / 1000) + OPERATOR_SESSION_TTL_SECONDS,
  });
}

export function verifySignedSession(cookieValue: string | undefined | null): AppSession | null {
  if (!cookieValue) return null;
  const [payloadB64, signature] = cookieValue.split(".");
  if (!payloadB64 || !signature) return null;

  const expected = sign(payloadB64);
  const signatureBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (signatureBuf.length !== expectedBuf.length) return null;
  const ok = crypto.timingSafeEqual(signatureBuf, expectedBuf);
  if (!ok) return null;

  try {
    const decoded = JSON.parse(fromBase64Url(payloadB64)) as AppSession;
    if (!decoded?.mode || !decoded?.userId || !Array.isArray(decoded?.allowedTournamentIds) || !decoded?.exp) {
      return null;
    }
    if (decoded.exp <= Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function setSessionCookie(response: NextResponse, signedSession: string, maxAgeSeconds?: number) {
  response.cookies.set(APP_SESSION_COOKIE, signedSession, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds ?? SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(APP_SESSION_COOKIE, "", {
    path: "/",
    maxAge: 0,
  });
}

export function requireSession(request: NextRequest):
  | { ok: true; session: AppSession }
  | { ok: false; response: NextResponse } {
  const raw = request.cookies.get(APP_SESSION_COOKIE)?.value;
  const session = verifySignedSession(raw);

  if (!session) {
    const response = NextResponse.json({ error: "認証が必要です" }, { status: 401 });
    clearSessionCookie(response);
    return { ok: false, response };
  }

  return { ok: true, session };
}
