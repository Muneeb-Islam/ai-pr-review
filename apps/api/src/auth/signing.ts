// Small HMAC helpers for cookies and CSRF tokens. Every use has its own label, so a value signed for one
// purpose is never valid for another.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const hmac = (secret: string, label: string, value: string): string =>
  createHmac("sha256", secret).update(`${label}\0${value}`).digest("base64url");

/** Constant-time string comparison (false for different lengths). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `value.signature`. */
export const sign = (secret: string, label: string, value: string): string =>
  `${value}.${hmac(secret, label, value)}`;

/** The value of a `sign()`ed string, or undefined if it was not signed with this secret and label. */
export function unsign(secret: string, label: string, signed: string): string | undefined {
  const dot = signed.lastIndexOf(".");
  if (dot < 1) return undefined;
  const value = signed.slice(0, dot);
  return safeEqual(signed.slice(dot + 1), hmac(secret, label, value)) ? value : undefined;
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

/** PKCE S256 challenge for a code verifier (RFC 7636). */
export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** The CSRF token of a session: derived, so only a holder of the session can know it, and nothing extra is stored. */
export const csrfTokenFor = (secret: string, sessionId: string, csrfSecret: string): string =>
  hmac(secret, "csrf", `${sessionId}:${csrfSecret}`);
