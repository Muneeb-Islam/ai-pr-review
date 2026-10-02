import { createHmac, timingSafeEqual } from "node:crypto";

const PREFIX = "sha256=";

/** `X-Hub-Signature-256` value for `body` (what GitHub sends; used by the replay script and tests). */
export function signWebhookPayload(secret: string, body: Uint8Array | string): string {
  return PREFIX + createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Verifies `X-Hub-Signature-256` over the RAW request body (design §4, PL-02). The comparison is constant
 * time. A missing, malformed or wrong-length header is simply "invalid": never throws, reveals nothing.
 */
export function verifyWebhookSignature(
  secret: string,
  body: Uint8Array | string,
  header: string | undefined,
): boolean {
  if (!secret || typeof header !== "string" || !header.startsWith(PREFIX)) return false;
  const expected = Buffer.from(signWebhookPayload(secret, body));
  const received = Buffer.from(header);
  // timingSafeEqual throws on different lengths, and the length of a hex digest is not secret.
  return received.length === expected.length && timingSafeEqual(received, expected);
}
