import { describe, expect, it } from "vitest";
import { fingerprintFinding } from "../validation/fingerprint";
import {
  scannerFinding,
  stubScannerAdapter,
  type ScannerAdapter,
  type ScannerContext,
} from "./scanner";

const context: ScannerContext = { headSha: "c".repeat(40), paths: new Set(["src/a.ts"]) };

describe("ScannerAdapter (FR-27)", () => {
  it("the stub is a working adapter that finds nothing", () => {
    expect(stubScannerAdapter.parse({ format: "sarif", content: "{}" }, context)).toEqual({
      findings: [],
      skipped: 0,
      warnings: [],
    });
  });

  it("builds findings that deduplicate against the platform's own", () => {
    const finding = scannerFinding(
      {
        severity: "high",
        confidence: 0.9,
        title: "Use of eval",
        filePath: "src/a.ts",
        startLine: 7,
        evidence: "eval(input)",
        impact: "Runs input as code.",
        recommendation: "Remove eval.",
      },
      context,
    );
    expect(finding).toMatchObject({
      agent: "security",
      category: "security",
      sourceCommitSha: context.headSha,
      id: fingerprintFinding({
        category: "security",
        title: "Use of eval",
        filePath: "src/a.ts",
        startLine: 7,
      }),
    });
  });

  it("is enough to write an adapter for a real format (a minimal SARIF reader as the example)", () => {
    const sarif: ScannerAdapter = {
      id: "sarif-example",
      formats: ["sarif"],
      parse(input, ctx) {
        const report = JSON.parse(input.content) as {
          runs: Array<{
            results: Array<{
              ruleId: string;
              level: string;
              message: { text: string };
              locations: Array<{
                physicalLocation: {
                  artifactLocation: { uri: string };
                  region: { startLine: number };
                };
              }>;
            }>;
          }>;
        };
        const findings = [];
        let skipped = 0;
        for (const result of report.runs.flatMap((run) => run.results)) {
          const where = result.locations[0]?.physicalLocation;
          if (!where || !ctx.paths.has(where.artifactLocation.uri)) {
            skipped += 1;
            continue;
          }
          findings.push(
            scannerFinding(
              {
                severity: result.level === "error" ? "high" : "medium",
                confidence: 0.9,
                title: result.ruleId,
                filePath: where.artifactLocation.uri,
                startLine: where.region.startLine,
                evidence: "reported by the scanner",
                impact: result.message.text,
                recommendation: "See the rule's documentation.",
              },
              ctx,
            ),
          );
        }
        return { findings, skipped, warnings: [] };
      },
    };
    const content = JSON.stringify({
      runs: [
        {
          results: [
            {
              ruleId: "js/eval",
              level: "error",
              message: { text: "Eval of user input." },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/a.ts" },
                    region: { startLine: 3 },
                  },
                },
              ],
            },
            {
              ruleId: "js/other",
              level: "note",
              message: { text: "Elsewhere." },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: "src/not-in-review.ts" },
                    region: { startLine: 1 },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const out = sarif.parse({ format: "sarif", content }, context);
    expect(out.findings.map((f) => [f.title, f.severity, f.startLine])).toEqual([
      ["js/eval", "high", 3],
    ]);
    expect(out.skipped).toBe(1);
  });
});
