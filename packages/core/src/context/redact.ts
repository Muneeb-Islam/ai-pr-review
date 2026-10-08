import { maskRegisteredSecrets } from "@ai-pr-review/shared";

// Redaction of high-confidence secret formats before text reaches a model (FR-10).
//
// Deliberately narrow: each rule matches a documented token format or a PEM block, so ordinary code is not
// touched. Generic "password = ..." assignments are NOT redacted; they would hide the bug under review, and
// the Security agent (Phase 12) is expected to flag a hard-coded credential from the surrounding code.
// Redaction never changes the number of lines, so diff line numbers and positions stay valid.

export interface RedactionResult {
  text: string;
  /** Number of secrets replaced. */
  count: number;
}

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Which capture group holds the secret; the whole match when omitted. */
  group?: number;
}

const RULES: Rule[] = [
  { kind: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: "github-token", pattern: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: "aws-access-key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "stripe-key", pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // OpenAI, Anthropic, DeepSeek and similar `sk-` keys.
  { kind: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  // `Authorization: Bearer <token>`; the word stays so the code still reads.
  { kind: "bearer-token", pattern: /\b[Bb]earer\s+([A-Za-z0-9._~+/=-]{24,})/g, group: 1 },
  // `https://user:password@host`; keep the user and host.
  {
    kind: "url-credentials",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@$<{%]+)@/gi,
    group: 1,
  },
];

const PRIVATE_KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;

const marker = (kind: string): string => `[REDACTED:${kind}]`;

function redactRules(line: string): RedactionResult {
  let count = 0;
  let out = line;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      count += 1;
      if (rule.group === undefined) return marker(rule.kind);
      const secret = args[rule.group] as string;
      return match.replace(secret, marker(rule.kind));
    });
  }
  return { text: out, count };
}

/**
 * Replaces secrets in `text` with `[REDACTED:<kind>]`. A private-key block is replaced line by line so the
 * line count is unchanged. `prefixWidth` is the width of the per-line diff prefix (`+`, `-`, ` ` = 1) that must
 * survive on every line of a block; use 0 for plain text.
 */
export function redactSecrets(
  text: string,
  options: { prefixWidth?: number } = {},
): RedactionResult {
  const prefixWidth = options.prefixWidth ?? 0;
  const lines = text.split("\n");
  let count = 0;
  let inKey = false;

  const out = lines.map((line) => {
    const prefix = line.slice(0, prefixWidth);
    const body = line.slice(prefixWidth);

    // A hunk header ends any block whose END line is outside this patch.
    if (prefixWidth > 0 && line.startsWith("@@ ")) inKey = false;

    if (inKey) {
      if (PRIVATE_KEY_END.test(body)) inKey = false;
      return `${prefix}${marker("private-key")}`;
    }
    if (PRIVATE_KEY_BEGIN.test(body)) {
      count += 1;
      // A one-line block (begin and end together) closes immediately.
      inKey = !PRIVATE_KEY_END.test(body);
      return `${prefix}${marker("private-key")}`;
    }
    // The secrets this process holds (provider keys, App keys, tokens), whatever their format: they must not reach a
    // model, a comment or a log even if they appear in a repository, a pull request or a model's own answer.
    const masked = maskRegisteredSecrets(body);
    if (masked !== body) count += 1;
    const result = redactRules(masked);
    count += result.count;
    return `${prefix}${result.text}`;
  });

  return { text: out.join("\n"), count };
}

/** Patch text: every line carries a one-character diff prefix. Hunk headers contain no secrets worth matching. */
export function redactPatch(patch: string): RedactionResult {
  return redactSecrets(patch, { prefixWidth: 1 });
}
