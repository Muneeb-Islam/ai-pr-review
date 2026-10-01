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

/**
 * Field values are limited to primitives and truncated, so source content,
 * diffs and secrets are not logged by accident. Never pass them as fields.
 */
function formatValue(value: string | number | boolean): string {
  const text = String(value).replace(/\s+/g, " ");
  const clipped = text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
  return /[\s="]/.test(clipped) ? JSON.stringify(clipped) : clipped;
}

export function formatLine(level: LogLevel, message: string, fields: LogFields): string {
  const parts = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return [level.toUpperCase().padEnd(5), message, ...parts].join(" ");
}

export function newRunId(env: NodeJS.ProcessEnv = process.env): string {
  return env["GITHUB_RUN_ID"] ?? randomBytes(4).toString("hex");
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
