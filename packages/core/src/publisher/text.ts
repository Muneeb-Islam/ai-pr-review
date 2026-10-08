// Everything that reaches GitHub passes through here (FR-29). Model output and repository text are untrusted: a
// prompt-injected answer must not be able to leak a secret, forge one of our hidden markers, ping people, load
// an image from another server, or paste a large excerpt of the code into a public comment.
import { redactSecrets } from "../context/redact";
import { sanitizeSecurityText, type SecurityScrub } from "../security/sanitize";

const ZWSP = "​";

export interface SanitizeOptions {
  maxChars: number;
  /** Fenced code blocks longer than this are cut (default 8 lines). */
  maxCodeLines?: number;
  /**
   * Text of a security finding: generic credentials and exploit payloads are removed too (FR-29). An object also
   * names the secret values the finding mentions, to be removed wherever they appear.
   */
  security?: boolean | SecurityScrub;
}

/** Splits text into code (fenced blocks and inline spans, odd indexes) and prose (even indexes). */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;

function mapProse(text: string, fn: (prose: string) => string): string {
  return text
    .split(CODE)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join("");
}

function limitCodeBlocks(text: string, maxLines: number): string {
  return text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_all, info: string, body: string) => {
    const lines = body.replace(/\n$/, "").split("\n");
    if (lines.length <= maxLines) return `\`\`\`${info}\n${body}\`\`\``;
    return `\`\`\`${info}\n${lines.slice(0, maxLines).join("\n")}\n…\n\`\`\``;
  });
}

/** Cuts at a character limit without leaving a fenced block open. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let out = `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
  if ((out.match(/```/g)?.length ?? 0) % 2 === 1) out += "\n```";
  return out;
}

/** Breaks our marker prefix and HTML comment openers, so text cannot pose as a fingerprint or summary marker. */
function breakMarkers(text: string): string {
  return text
    .replace(/ai-pr-review:/gi, (m) => `${m.slice(0, -1)}${ZWSP}:`)
    .replace(/<!--/g, `<${ZWSP}!--`);
}

/**
 * Makes untrusted text safe to publish:
 *  - secrets in known token formats become `[REDACTED:<kind>]`;
 *  - our marker prefix and HTML comments are broken, so text cannot pose as a fingerprint or summary marker;
 *  - markdown images and link targets are dropped (an image URL can carry data to another server);
 *  - HTML tags and @mentions outside code are neutralised;
 *  - long code blocks are cut and the whole text is limited to `maxChars`.
 */
export function sanitizeText(input: string, options: SanitizeOptions): string {
  const normalized = input.replace(/\r\n?/g, "\n");
  let text = options.security
    ? sanitizeSecurityText(
        normalized,
        typeof options.security === "object" ? options.security : undefined,
      ).text
    : redactSecrets(normalized).text;
  text = breakMarkers(text);
  text = mapProse(text, (prose) =>
    prose
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/<(?=[A-Za-z/!?])/g, "&lt;")
      .replace(/(^|[^\w@])@(?=[A-Za-z0-9])/g, `$1@${ZWSP}`),
  );
  text = limitCodeBlocks(text, options.maxCodeLines ?? 8);
  return truncate(text.trim(), options.maxChars);
}

/** A single line of plain text (titles, paths): no newlines, no markup that changes the layout. */
export function sanitizeLine(
  input: string,
  maxChars: number,
  security: boolean | SecurityScrub = false,
): string {
  const text = sanitizeText(input, { maxChars: maxChars * 2, security })
    .replace(/\s+/g, " ")
    .replace(/`/g, "'")
    .replace(/\|/g, "\\|");
  return truncate(text, maxChars);
}

/** Inline code for a path or short identifier; backticks inside are replaced so the span cannot be closed early. */
export function codeSpan(input: string, maxChars = 200): string {
  const clean = breakMarkers(redactSecrets(input).text).replace(/[`\n\r]/g, "'");
  return `\`${truncate(clean, maxChars)}\``;
}

/** Final pass over a finished body: a last redaction, and a hard cap below GitHub's 65 536-character limit. */
export function finalizeBody(body: string, maxChars: number): string {
  return truncate(redactSecrets(body).text, maxChars);
}
