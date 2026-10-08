// CSP-compatibility (design §9): the shell has no inline script, no inline event handlers and no inline style
// attributes, so the dashboard can be served with `script-src 'self'`.
import { describe, expect, it } from "vitest";
import { readWebFile } from "./readSource";

const html = readWebFile("index.html");

describe("index.html", () => {
  it("loads its code from files only", () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=/);
      expect((body ?? "").trim()).toBe("");
    }
  });

  it("has no inline event handlers or style attributes", () => {
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
  });
});
