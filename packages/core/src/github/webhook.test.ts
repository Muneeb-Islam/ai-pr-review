import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "./webhook";

const secret = "It's a Secret to Everybody";
const body = "Hello, World!";

describe("webhook signature (AC-13)", () => {
  it("matches GitHub's documented test vector", () => {
    // From https://docs.github.com/webhooks/using-webhooks/validating-webhook-deliveries
    expect(signWebhookPayload(secret, body)).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });

  it("accepts a valid signature, for text and for bytes", () => {
    expect(verifyWebhookSignature(secret, body, signWebhookPayload(secret, body))).toBe(true);
    const bytes = Buffer.from(body);
    expect(verifyWebhookSignature(secret, bytes, signWebhookPayload(secret, bytes))).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "")).toBe(false);
  });

  it("rejects an invalid signature", () => {
    const wrong = "sha256=" + "0".repeat(64);
    expect(verifyWebhookSignature(secret, body, wrong)).toBe(false);
  });

  it("rejects a body that was modified after signing", () => {
    const header = signWebhookPayload(secret, body);
    expect(verifyWebhookSignature(secret, body + " ", header)).toBe(false);
    expect(verifyWebhookSignature(secret, "hello, World!", header)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = signWebhookPayload("another secret", body);
    expect(verifyWebhookSignature(secret, body, header)).toBe(false);
  });

  it("rejects malformed headers without throwing", () => {
    const good = signWebhookPayload(secret, body);
    for (const header of [
      good.slice("sha256=".length), // no prefix
      "sha1=" + good.slice("sha256=".length), // legacy algorithm label
      good.slice(0, -2), // too short
      good + "00", // too long
      "sha256=zz",
      "Bearer x",
    ]) {
      expect(verifyWebhookSignature(secret, body, header)).toBe(false);
    }
  });

  it("never accepts anything when no secret is configured", () => {
    expect(verifyWebhookSignature("", body, signWebhookPayload("", body))).toBe(false);
  });
});
