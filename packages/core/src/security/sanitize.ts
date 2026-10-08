import { redactSecrets } from "../context/redact";

// Security-specific rules for text that leaves the platform (FR-29): a security finding describes a risk and its
// mitigation, never a working exploit, a live credential or a sensitive code fragment. These rules extend the
// token-format redaction of Phase 5 and 9 with the two things it deliberately leaves alone before the model reads
// the diff: generic hard-coded credentials (the Security agent has to see them to flag them) and exploit payloads
// (a model may quote one as "evidence"). They run twice: in the Security agent, so nothing sensitive reaches the
// database or the dashboard, and in the publisher, so a finding from any other source is cleaned the same way.

export interface SecuritySanitizeResult {
  text: string;
  /** Credentials and payloads replaced. */
  count: number;
}

const CREDENTIAL = "[REDACTED:credential]";
const SECRET_LITERAL = "[REDACTED:secret-literal]";
const PAYLOAD = "[payload omitted]";

/** Names that say the value is a secret: `dbPassword`, `API_KEY`, `client_secret`, `authToken`, `"private_key"`. */
const SECRET_NAME =
  "[\\w.-]*(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|auth(?:orization)?)[\\w.-]*";

/** `name = "value"`, `name: 'value'`, `"name": "value"`, `headers.authorization = \`value\``. The value is replaced. */
const QUOTED_CREDENTIAL = new RegExp(
  `(\\b${SECRET_NAME}["']?\\s*[:=]\\s*)(["'\`])((?:(?!\\2)[^\\n]){4,}?)\\2`,
  "gi",
);

/** `export API_KEY=abcd1234...` and `.env` style lines with no quotes. */
const UNQUOTED_CREDENTIAL = new RegExp(`(\\b${SECRET_NAME}\\s*=\\s*)([^\\s"'\`;,)]{8,})`, "gi");

/** A quoted run of base64 or hex-like characters that is long enough to be a key. Checked for entropy below. */
const LONG_LITERAL = /(["'`])([A-Za-z0-9+/=_-]{28,})\1/g;

const ALREADY_REDACTED = /^\[REDACTED[:\]]/;
/** Values that are references, not secrets: `process.env.X`, `${...}`, placeholders. */
const PLACEHOLDER =
  /^(?:\$\{|<[^>]*>$|\{\{|x{4,}$|\*{4,}$|changeme$|your[-_ ]|example|placeholder)/i;

function shannonEntropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** A long identifier or a path is not a key; a random-looking mix of letters and digits is. */
function looksRandom(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && shannonEntropy(value) >= 3.6;
}

/**
 * Exploit payloads: the strings that make a weakness work. Naming the weakness is the finding; the string that
 * triggers it is not published. Each rule needs the shape of an attack, so ordinary code is left alone: one `../`
 * is a path, three in a row are a traversal.
 */
const PAYLOADS: RegExp[] = [
  // SQL injection
  // a tautology after a quote (`' or 1=1`, `' OR 'a'='a`); ordinary SQL such as `AND b = 'y'` is left alone
  /['"]\s*or\s+['"]?(\w+)['"]?\s*=\s*['"]?\1\b['"]?(?:\s*(?:--|#|\/\*)[^\n]*)?/gi,
  /\bunion\s+(?:all\s+)?select\b[^\n"'`]{0,80}/gi,
  /;\s*(?:drop|truncate|delete\s+from|insert\s+into|update)\s+\w+[^\n"'`]{0,60}/gi,
  // path traversal, plain and URL-encoded
  // three or more in a row; one or two are ordinary relative imports
  /(?:(?:\.\.|%2e%2e)(?:[\\/]|%2f|%5c)){3,}[\w./\\%-]*/gi,
  /(?:(?:\.\.|%2e%2e)(?:[\\/]|%2f|%5c))+(?:etc|windows|proc|root|boot\.ini)\b[\w./\\%-]*/gi,
  /\/etc\/(?:passwd|shadow)\b|[a-z]:\\windows\\system32\S*/gi,
  // script injection
  /<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi,
  /\bon(?:error|load|click|mouseover|focus)\s*=\s*["']?[^"'\s>]*(?:alert|prompt|confirm|eval|fetch)\s*\([^)\n]*\)?/gi,
  /\bjavascript:[^\s"'`)]+/gi,
  // command injection
  /(?:;|&&|\|\||\|)\s*(?:rm\s+-rf?|curl|wget|nc|ncat|bash|sh|powershell|cmd(?:\.exe)?\s*\/c)\b[^\n"'`]{0,80}/gi,
  // shell command substitution; `$("#id")` (jQuery) is not one
  /\$\(\s*(?:curl|wget|cat|id|whoami|ls|rm|nc|bash|sh|echo|uname|sleep|ping)\b(?:[^()\n]|\([^()\n]*\)){0,80}\)/gi,
  // NoSQL operators used as injection
  /\{\s*["']?\$(?:ne|gt|gte|lt|regex|where|exists|or)["']?\s*:[^}\n]{0,60}\}?/gi,
  // server-side request forgery targets
  /\b(?:https?:\/\/)?169\.254\.169\.254[\w/.:-]*|\bmetadata\.google\.internal[\w/.:-]*/gi,
  // template and prototype injection
  /\{\{\s*(?:constructor|this\.constructor|[^}]*\bprocess\b)[^}\n]*\}\}/gi,
  /["']__proto__["']\s*:\s*\{[^}\n]*\}/g,
];

/** Secret values to remove wherever they appear, found by `secretLiteralsIn` or read from the diff. */
export interface SecurityScrub {
  known: readonly string[];
}

/** Shorter values are too likely to be ordinary words to remove everywhere. */
const MIN_KNOWN_LENGTH = 6;

/**
 * The secret-looking values in `text`: strings assigned to a name that says secret, and long random-looking
 * literals. A model that quotes one in a finding does not always keep it in the assignment's shape (`Rotate the
 * key abc123...`), so these values are then removed from the whole finding, not only from the line they were in.
 */
export function secretLiteralsIn(text: string): string[] {
  const found = new Set<string>();
  const add = (value: string | undefined) => {
    if (
      value !== undefined &&
      value.length >= MIN_KNOWN_LENGTH &&
      !ALREADY_REDACTED.test(value) &&
      !PLACEHOLDER.test(value)
    ) {
      found.add(value);
    }
  };
  for (const match of text.matchAll(QUOTED_CREDENTIAL)) add(match[3]);
  for (const match of text.matchAll(UNQUOTED_CREDENTIAL)) add(match[2]);
  for (const match of text.matchAll(LONG_LITERAL)) if (looksRandom(match[2] ?? "")) add(match[2]);
  return [...found];
}

/** What to scrub from one finding's texts: the secrets that any of its own fields shows. */
export function securityScrub(finding: {
  title: string;
  evidence: string;
  impact: string;
  recommendation: string;
}): SecurityScrub {
  return {
    known: secretLiteralsIn(
      [finding.evidence, finding.title, finding.impact, finding.recommendation].join("\n"),
    ),
  };
}

/** Credentials and exploit payloads removed from text that may be published. */
export function sanitizeSecurityText(
  input: string,
  scrub?: SecurityScrub | undefined,
): SecuritySanitizeResult {
  const redacted = redactSecrets(input);
  let count = redacted.count;
  let text = redacted.text;
  for (const value of scrub?.known ?? []) {
    if (value.length < MIN_KNOWN_LENGTH || !text.includes(value)) continue;
    count += 1;
    text = text.split(value).join(CREDENTIAL);
  }

  text = text.replace(
    QUOTED_CREDENTIAL,
    (match: string, head: string, quote: string, value: string) => {
      if (ALREADY_REDACTED.test(value) || PLACEHOLDER.test(value)) return match;
      count += 1;
      return `${head}${quote}${CREDENTIAL}${quote}`;
    },
  );
  text = text.replace(UNQUOTED_CREDENTIAL, (match: string, head: string, value: string) => {
    if (ALREADY_REDACTED.test(value) || PLACEHOLDER.test(value) || /^(?:process|env)\b/.test(value))
      return match;
    count += 1;
    return `${head}${CREDENTIAL}`;
  });
  text = text.replace(LONG_LITERAL, (match: string, quote: string, value: string) => {
    if (!looksRandom(value)) return match;
    count += 1;
    return `${quote}${SECRET_LITERAL}${quote}`;
  });
  for (const pattern of PAYLOADS) {
    text = text.replace(pattern, () => {
      count += 1;
      return PAYLOAD;
    });
  }
  return { text, count };
}
