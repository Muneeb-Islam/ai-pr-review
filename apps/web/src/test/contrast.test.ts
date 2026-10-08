// WCAG AA (4.5:1 for text) for every foreground/background pair of the colour tokens, in both themes.
// The tokens live in styles.css; this reads them from there so the check cannot drift from the design.
import { describe, expect, it } from "vitest";
import { readWebFile } from "./readSource";

const css = readWebFile("src/styles.css");

function tokens(block: RegExp): Record<string, string> {
  const body = block.exec(css)?.[1] ?? "";
  return Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((m) => [m[1]!, m[2]!]),
  );
}

const light = tokens(/:root\s*\{([\s\S]*?)\r?\n\}/);
const dark = { ...light, ...tokens(/\.dark\s*\{([\s\S]*?)\r?\n\}/) };

function luminance(hex: string): number {
  const channel = (offset: number) => {
    const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "skipped",
  "superseded",
  "cancelled",
];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];

const pairs: Array<[string, string, string]> = [
  ["text on the page", "fg", "bg"],
  ["text on a card", "fg", "surface"],
  ["text on a tinted surface", "fg", "surface-2"],
  ["text on the highlighted (in progress) row", "fg", "highlight"],
  ["muted text on the page", "muted", "bg"],
  ["muted text on a card", "muted", "surface"],
  ["muted text on a tinted surface", "muted", "surface-2"],
  ["muted text on the highlighted row", "muted", "highlight"],
  ["links on the page", "accent", "bg"],
  ["links on a card", "accent", "surface"],
  ["links on the highlighted row", "accent", "highlight"],
  ["primary button text", "accent-fg", "accent"],
  ["error text on a card", "danger", "surface"],
  ...STATUSES.map((s): [string, string, string] => [`${s} badge`, `st-${s}-fg`, `st-${s}-bg`]),
  ...SEVERITIES.map((s): [string, string, string] => [`${s} badge`, `sev-${s}-fg`, `sev-${s}-bg`]),
];

describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme contrast", (_name, theme) => {
  it("defines every token it is checked against", () => {
    for (const [, fg, bg] of pairs) {
      expect(theme[fg], fg).toBeDefined();
      expect(theme[bg], bg).toBeDefined();
    }
  });

  it.each(pairs)("%s is at least 4.5:1", (_label, fg, bg) => {
    expect(contrast(theme[fg]!, theme[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});

// Chart marks are graphics, not text: WCAG asks 3:1 against the surface they sit on (the card). The slots were
// chosen with the dataviz palette validator (lightness band, chroma, colour-vision separation of neighbours).
describe.each([
  ["light", light],
  ["dark", dark],
] as const)("%s theme chart colours", (_name, theme) => {
  it.each(["chart-1", "chart-2", "chart-3"])("%s is at least 3:1 on a card", (token) => {
    expect(contrast(theme[token]!, theme["surface"]!)).toBeGreaterThanOrEqual(3);
  });

  it("keeps the grid quieter than the marks", () => {
    expect(contrast(theme["chart-grid"]!, theme["surface"]!)).toBeLessThan(
      contrast(theme["chart-1"]!, theme["surface"]!),
    );
  });
});
