import crypto from "crypto";

export function normalizeAccessCode(input: string) {
  return String(input || "").trim().toUpperCase();
}

export function hashAccessCode(code: string) {
  return crypto.createHash("sha256").update(normalizeAccessCode(code), "utf8").digest("hex");
}

export function timingSafeEqualHex(a: string, b: string) {
  const aBuf = Buffer.from(String(a || ""), "hex");
  const bBuf = Buffer.from(String(b || ""), "hex");
  if (!aBuf.length || !bBuf.length || aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function maskCode(code: string) {
  const normalized = normalizeAccessCode(code);
  if (normalized.length <= 4) return "****";
  return `****-****-${normalized.slice(-4)}`;
}

export function generateAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const block = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${block()}-${block()}-${block()}`;
}
