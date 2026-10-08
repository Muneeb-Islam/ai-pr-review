// Validation of configuration layers, free of Node-only code (no YAML) so the dashboard form can run exactly the
// checks the api runs (UI-06): the same schema, the same messages.
import type { z } from "zod";
import { configSchema } from "./schema";

function valueAt(raw: unknown, path: PropertyKey[]): unknown {
  let cur: unknown = raw;
  for (const key of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[key];
  }
  return cur;
}

export function formatIssues(issues: z.core.$ZodIssue[], raw: unknown): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const base = issue.path.map(String);
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        out.push(`${[...base, key].join(".")}: unknown key`);
      }
      continue;
    }
    const key = base.join(".") || "(root)";
    const isMissing = valueAt(raw, issue.path) === undefined;
    out.push(isMissing ? `${key}: required` : `${key}: ${issue.message}`);
  }
  return out;
}

/**
 * Checks a dashboard-layer configuration (any subset of the config keys) the way the stored settings are
 * validated: unknown keys and invalid values are reported by path.
 */
export function validateDashboardConfig(
  raw: Record<string, unknown>,
): { ok: true } | { ok: false; problems: string[] } {
  const result = configSchema.partial().safeParse(raw);
  return result.success
    ? { ok: true }
    : { ok: false, problems: formatIssues(result.error.issues, raw) };
}

/**
 * The dotted paths of the settings a configuration sets (`review.mode`, `ignore`): mappings are walked, arrays
 * and scalars are leaves. The api reports which keys the repository file sets with it, and the form uses it to
 * lock those fields.
 */
export function configLeafPaths(raw: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "object" && !Array.isArray(value)) {
      out.push(...configLeafPaths(value as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out.sort();
}
