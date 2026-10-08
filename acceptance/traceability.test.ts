// The acceptance suite keeps its promise: every criterion AC-1 to AC-23 has automated evidence, the evidence exists,
// and docs/acceptance.md says what the code says.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CRITERIA, renderTraceability } from "./traceability";

const ROOT = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");

/** The titles of the `it`, `test` and `describe` calls in a test file. */
function titles(source: string): string[] {
  const pattern = /\b(?:it|test|describe)(?:\.\w+)*\(\s*(["'`])((?:[\\][\s\S]|(?!\1)[\s\S])*?)\1/g;
  return [...source.matchAll(pattern)].map((m) => m[2]!);
}

describe("acceptance traceability", () => {
  it("covers AC-1 to AC-23, each once", () => {
    expect(CRITERIA.map((c) => c.id)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
  });

  it("gives every criterion automated evidence", () => {
    for (const c of CRITERIA) expect(c.evidence.length, `AC-${c.id}`).toBeGreaterThan(0);
  });

  for (const c of CRITERIA) {
    it(`AC-${c.id}: every listed test exists`, () => {
      for (const e of c.evidence) {
        expect(existsSync(resolve(ROOT, e.file)), `${e.file} exists`).toBe(true);
        const found = titles(read(e.file)).some((title) => title.includes(e.test));
        expect(found, `${e.file} has a test or group titled "${e.test}"`).toBe(true);
      }
    });
  }

  it("is what docs/acceptance.md says (regenerate with `npm run acceptance:doc`)", () => {
    // A Windows checkout may have turned line endings into CRLF.
    expect(read("docs/acceptance.md").replace(/\r\n/g, "\n")).toBe(renderTraceability());
  });
});
