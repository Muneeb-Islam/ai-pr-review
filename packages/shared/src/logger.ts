import { randomBytes } from "node:crypto";

export type LogFields = Record<string, string | number | boolean | undefined>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` (e.g. `pr`, `agent`) to every line. */
  child(fields: LogFields): Logger;
  /** Runs `fn`, logging its duration and outcome (`status=ok|failed`). */
  timed<T>(name: string, fn: () => Promise<T>, fields?: LogFields): Promise<T>;
}

export type LogSink = (line: string, level: LogLevel) => void;

const MAX_VALUE_LENGTH = 200;
const REDACTED = "[redacted]";

/** Field names whose values are never logged. */
const SENSITIVE_KEY =
  /token|secret|password|passwd|authorization|api[_-]?key|private[_-]?key|cookie/i;

/** Shapes of credentials that must not appear in any log text. */
const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek / Anthropic style keys
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs (app and session tokens)
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

const secretValues = new Set<string>();

/** Registers an exact secret value (an API key, installation token) to be masked in all log output. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 4) secretValues.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secretValues) out = out.split(secret).join(REDACTED);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/**
 * Field values are limited to primitives, truncated and redacted, so source content,
 * diffs and secrets are not logged by accident. Never pass them as fields.
 */
function formatValue(key: string, value: string | number | boolean): string {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  const text = redact(String(value)).replace(/\s+/g, " ");
  const clipped = text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}�` : text;
  return /[\s="]/.test(clipped) ? JSON.stringify(clipped) : clipped;
}

export function formatLine(level: LogLevel, message: string, fields: LogFields): string {
  const parts = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${formatValue(key, value)}`);
  return [level.toUpperCase().padEnd(5), redact(message), ...parts].join(" ");
}

export function newRunId(): string {
  return randomBytes(4).toString("hex");
}

/** Context carried by every line of a review run (design �16). */
export interface RunLogContext {
  runId: string;
  repo: string; // owner/name
  prNumber: number;
}

export function runLogger(logger: Logger, ctx: RunLogContext): Logger {
  return logger.child({ runId: ctx.runId, repo: ctx.repo, prNumber: ctx.prNumber });
}

const stdoutSink: LogSink = (line) => {
  process.stdout.write(`${line}\n`);
};

export function createLogger(
  base: LogFields,
  sink: LogSink = stdoutSink,
  now: () => number = Date.now,
): Logger {
  const emit = (level: LogLevel, message: string, fields: LogFields = {}) =>
    sink(formatLine(level, message, { ...base, ...fields }), level);

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (fields) => createLogger({ ...base, ...fields }, sink, now),
    async timed(name, fn, fields) {
      const start = now();
      try {
        const result = await fn();
        emit("info", name, { ...fields, status: "ok", durationMs: now() - start });
        return result;
      } catch (err) {
        emit("error", name, { ...fields, status: "failed", durationMs: now() - start });
        throw err;
      }
    },
  };
}
