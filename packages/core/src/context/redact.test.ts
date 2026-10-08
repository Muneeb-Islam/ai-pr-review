import { describe, expect, it } from "vitest";
import { redactPatch, redactSecrets } from "./redact";
import { FAKE, patch } from "./test-support";

describe("redactSecrets", () => {
  it.each([
    ["GitHub token", FAKE.github],
    ["AWS access key", FAKE.aws],
    ["OpenAI-style key", FAKE.openai],
    ["Slack token", FAKE.slack],
  ])("replaces a %s", (_name, secret) => {
    const { text, count } = redactSecrets(`const k = "${secret}";`);
    expect(text).not.toContain(secret);
    expect(text).toContain("[REDACTED:");
    expect(count).toBe(1);
  });

  it("replaces a bearer token but keeps the word", () => {
    const { text } = redactSecrets(`headers.Authorization = "Bearer ${FAKE.bearer}";`);
    expect(text).not.toContain(FAKE.bearer);
    expect(text).toContain("Bearer [REDACTED:bearer-token]");
  });

  it("replaces a JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop";
    expect(redactSecrets(`token=${jwt}`).text).not.toContain(jwt);
  });

  it("replaces the password of a URL but keeps user and host", () => {
    const { text } = redactSecrets("postgres://app:hunter2hunter2@db.internal:5432/app");
    expect(text).toBe("postgres://app:[REDACTED:url-credentials]@db.internal:5432/app");
  });

  it("replaces a private key block line by line", () => {
    const input = [
      "before",
      "-----BEGIN RSA PRIVATE KEY-----",
      FAKE.privateKeyBody,
      "-----END RSA PRIVATE KEY-----",
      "after",
    ].join("\n");
    const { text, count } = redactSecrets(input);
    expect(text.split("\n")).toHaveLength(5);
    expect(text).not.toContain(FAKE.privateKeyBody);
    expect(text).not.toContain("PRIVATE KEY");
    expect(text.startsWith("before")).toBe(true);
    expect(text.endsWith("after")).toBe(true);
    expect(count).toBe(1);
  });

  it("leaves ordinary code, placeholders and short strings alone", () => {
    const code = [
      "const key = process.env.API_KEY;",
      "const header = `Bearer ${token}`;",
      "const url = `https://${user}:${pass}@host`;",
      'const sk = "sk-short";',
      "// Bearer authentication is described in RFC 6750",
      'const id = "AKIA";',
      'password = "changeme"',
    ].join("\n");
    expect(redactSecrets(code)).toEqual({ text: code, count: 0 });
  });
});

describe("redactPatch", () => {
  it("keeps every line and its diff prefix, so line numbers and positions do not move", () => {
    const input = patch(
      "@@ -1,2 +1,6 @@",
      " keep",
      `+const a = "${FAKE.github}";`,
      "+-----BEGIN PRIVATE KEY-----",
      `+${FAKE.privateKeyBody}`,
      "+-----END PRIVATE KEY-----",
      "-removed",
    );
    const { text, count } = redactPatch(input);
    const before = input.split("\n");
    const after = text.split("\n");
    expect(after).toHaveLength(before.length);
    after.forEach((line, i) => expect(line[0]).toBe(before[i]?.[0]));
    expect(text).not.toContain(FAKE.github);
    expect(text).not.toContain(FAKE.privateKeyBody);
    expect(count).toBe(2);
  });

  it("stops redacting an unterminated key at the next hunk", () => {
    const input = patch(
      "@@ -1,1 +1,2 @@",
      "+-----BEGIN PRIVATE KEY-----",
      `+${FAKE.privateKeyBody}`,
      "@@ -10,1 +11,2 @@",
      " const visible = true;",
    );
    expect(redactPatch(input).text).toContain("const visible = true;");
  });
});
