// Matching findings across successive commits and tracking what became of the previous review's findings
// (FR-36, FR-37). The sequences below are the "fixture sequences of successive commits" the phase file asks the
// fingerprint to be tuned on: a persisting finding must keep being recognised after small edits, and a different
// finding must not hide behind an old one.
import type { AgentRunStatus, Finding } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { makeFinding } from "../agents/test-support";
import { fingerprintFinding } from "../validation/fingerprint";
import {
  countTracked,
  LINE_SHIFT_TOLERANCE,
  matchFindings,
  similarTitles,
  trackFindings,
  type PreviousFinding,
} from "./index";

function finding(over: Partial<Finding> & { title: string }): Finding {
  const base = makeFinding({
    category: "bug",
    filePath: "src/a.ts",
    startLine: 20,
    endLine: 20,
    ...over,
  });
  return {
    ...base,
    id: fingerprintFinding({
      category: base.category,
      title: base.title,
      filePath: base.filePath,
      startLine: base.startLine,
    }),
  };
}

const previousOf = (f: Finding, posted = true): PreviousFinding => ({
  fingerprint: f.id,
  agent: f.agent,
  category: f.category,
  severity: f.severity,
  title: f.title,
  ...(f.filePath !== undefined ? { filePath: f.filePath } : {}),
  ...(f.startLine !== undefined ? { startLine: f.startLine } : {}),
  posted,
});

describe("matching a finding with the previous review's", () => {
  it("pairs by fingerprint first", () => {
    const before = finding({ title: "Missing await on save" });
    const { pairs, unmatched } = matchFindings([before], [previousOf(before)]);
    expect(pairs.get(before)?.fingerprint).toBe(before.id);
    expect(unmatched).toEqual([]);
  });

  it("keeps recognising a finding that moved a few lines across a fingerprint bucket", () => {
    const before = finding({ title: "Missing await on save", startLine: 24 });
    const after = finding({ title: "Missing await on save", startLine: 27 }); // bucket 4 -> 5
    expect(after.id).not.toBe(before.id);
    expect(matchFindings([after], [previousOf(before)]).pairs.get(after)).toBeDefined();
  });

  it("keeps recognising a finding the model worded a little differently", () => {
    const before = finding({ title: "Missing await on the save call" });
    const after = finding({ title: "Missing await on save call" });
    expect(matchFindings([after], [previousOf(before)]).pairs.get(after)).toBeDefined();
  });

  it("does not pair a different problem in the same file", () => {
    const before = finding({ title: "Missing await on save" });
    const other = finding({ title: "Unbounded query inside a loop", startLine: 22 });
    expect(matchFindings([other], [previousOf(before)]).pairs.size).toBe(0);
  });

  it("does not pair the same sentence far away, in another file, or of another category", () => {
    const before = finding({ title: "Missing await on save" });
    const far = finding({
      title: "Missing await on save",
      startLine: 20 + LINE_SHIFT_TOLERANCE + 1,
    });
    const elsewhere = finding({ title: "Missing await on save", filePath: "src/b.ts" });
    const kind = finding({ title: "Missing await on save", category: "performance" });
    expect(matchFindings([far, elsewhere, kind], [previousOf(before)]).pairs.size).toBe(0);
  });

  it("pairs one to one: two findings cannot both continue the same earlier one", () => {
    const before = finding({ title: "Missing await on save" });
    const first = finding({ title: "Missing await on save", startLine: 21 });
    const second = finding({ title: "Missing await on save call", startLine: 22 });
    const { pairs } = matchFindings([first, second], [previousOf(before)]);
    expect(pairs.size).toBe(1);
  });

  it("an exact fingerprint wins over a loose match for the same earlier finding", () => {
    const old = finding({ title: "Missing await on save" });
    const same = finding({ title: "Missing await on save" });
    const looser = finding({ title: "Missing await on save call", startLine: 21 });
    const { pairs } = matchFindings([looser, same], [previousOf(old)]);
    expect(pairs.get(same)).toBeDefined();
    expect(pairs.get(looser)).toBeUndefined();
  });

  it("compares titles by their words, not their punctuation", () => {
    expect(similarTitles("Missing  await!", "missing await")).toBe(true);
    expect(similarTitles("Missing await on save", "Unbounded query inside a loop")).toBe(false);
    expect(similarTitles("", "anything")).toBe(false);
  });
});

describe("tracking what became of the previous review's findings (FR-37)", () => {
  const agents = (...statuses: Array<[Finding["agent"], AgentRunStatus]>) =>
    statuses.map(([agent, status]) => ({ agent, status }));
  const context = (files: Array<[string, "modified" | "removed"]>, skipped: string[] = []) => ({
    files: files.map(([path, status]) => ({
      path,
      status,
      additions: 1,
      deletions: 0,
      addedLines: [],
    })),
    skippedFiles: skipped.map((path) => ({ path, reason: "over the size limit" })),
  });

  const awaitBug = finding({ title: "Missing await on save" });
  const loopQuery = finding({
    title: "Query inside a loop",
    filePath: "src/b.ts",
    severity: "medium",
  });
  const previous = {
    runId: "run-1",
    headSha: "a".repeat(40),
    findings: [previousOf(awaitBug), previousOf(loopQuery)],
  };

  it("has nothing to say when the previous review found nothing", () => {
    expect(
      trackFindings({
        previous: { ...previous, findings: [] },
        current: [awaitBug],
        context: context([["src/a.ts", "modified"]]),
        agents: agents(["code_review", "ok"]),
      }),
    ).toBeUndefined();
  });

  it("calls a finding resolved only when the code was looked at again and the problem is gone", () => {
    const tracking = trackFindings({
      previous,
      current: [awaitBug],
      context: context([
        ["src/a.ts", "modified"],
        ["src/b.ts", "modified"],
      ]),
      agents: agents(["code_review", "ok"]),
    })!;
    const states = Object.fromEntries(tracking.items.map((i) => [i.title, i.state]));
    expect(states).toEqual({
      "Missing await on save": "still_applicable",
      "Query inside a loop": "resolved",
    });
    expect(tracking).toMatchObject({ previousRunId: "run-1", previousHeadSha: previous.headSha });
    expect(countTracked(tracking.items)).toEqual({
      resolved: 1,
      still_applicable: 1,
      not_evaluated: 0,
    });
  });

  it("does not call a finding resolved when the agent that found it did not finish", () => {
    for (const status of ["failed", "timeout", "invalid_output"] as const) {
      const tracking = trackFindings({
        previous,
        current: [],
        context: context([
          ["src/a.ts", "modified"],
          ["src/b.ts", "modified"],
        ]),
        agents: agents(["code_review", status]),
      })!;
      expect(tracking.items.map((i) => i.state)).toEqual(["not_evaluated", "not_evaluated"]);
      expect(tracking.items[0]?.reason).toContain("did not finish");
    }
  });

  it("does not call a finding resolved when its agent did not run at all", () => {
    const tracking = trackFindings({
      previous,
      current: [],
      context: context([
        ["src/a.ts", "modified"],
        ["src/b.ts", "modified"],
      ]),
      agents: [],
    })!;
    expect(tracking.items.every((i) => i.state === "not_evaluated")).toBe(true);
    expect(tracking.items[0]?.reason).toContain("did not run");
  });

  it("does not call a finding resolved when its file was left out of this review", () => {
    const tracking = trackFindings({
      previous,
      current: [],
      context: context([["src/a.ts", "modified"]], ["src/b.ts"]),
      agents: agents(["code_review", "ok"]),
    })!;
    const left = tracking.items.find((i) => i.title === "Query inside a loop")!;
    expect(left.state).toBe("not_evaluated");
    expect(left.reason).toContain("not reviewed this time");
    expect(left.reason).toContain("over the size limit");
  });

  it("calls a finding resolved when its file was deleted or is no longer part of the pull request", () => {
    const tracking = trackFindings({
      previous,
      current: [],
      context: context([["src/a.ts", "removed"]]),
      agents: agents(["code_review", "ok"]),
    })!;
    const byTitle = Object.fromEntries(tracking.items.map((i) => [i.title, i]));
    expect(byTitle["Missing await on save"]).toMatchObject({
      state: "resolved",
      reason: expect.stringContaining("deleted"),
    });
    expect(byTitle["Query inside a loop"]).toMatchObject({
      state: "resolved",
      reason: expect.stringContaining("no longer changed"),
    });
  });

  it("orders resolved first, then still applicable, then not evaluated, most severe first", () => {
    const highResolved = finding({
      title: "Race on counter",
      filePath: "src/c.ts",
      severity: "high",
    });
    const lowResolved = finding({
      title: "Stale comment",
      filePath: "src/c.ts",
      startLine: 90,
      severity: "low",
    });
    const tracking = trackFindings({
      previous: {
        ...previous,
        findings: [previousOf(lowResolved), previousOf(awaitBug), previousOf(highResolved)],
      },
      current: [awaitBug],
      context: context([
        ["src/a.ts", "modified"],
        ["src/c.ts", "modified"],
      ]),
      agents: agents(["code_review", "ok"]),
    })!;
    expect(tracking.items.map((i) => `${i.state}:${i.title}`)).toEqual([
      "resolved:Race on counter",
      "resolved:Stale comment",
      "still_applicable:Missing await on save",
    ]);
  });

  describe("across successive commits", () => {
    // Commit 1 finds two problems. Commit 2 fixes one, edits above the other (it moves four lines) and adds a
    // new one. Commit 3 fixes the second.
    const files = context([["src/a.ts", "modified"]]);
    const ok = agents(["code_review", "ok"]);

    it("follows each finding through the sequence", () => {
      const c1a = finding({ title: "Missing await on save", startLine: 24 });
      const c1b = finding({ title: "Retry loop never stops", startLine: 60 });
      const afterC1 = [previousOf(c1a), previousOf(c1b)];

      const c2a = finding({ title: "Missing await on save", startLine: 28 }); // moved, new fingerprint
      const c2new = finding({
        title: "Token written to the log",
        startLine: 5,
        category: "security",
      });
      const second = trackFindings({
        previous: { runId: "r1", headSha: "1".repeat(40), findings: afterC1 },
        current: [c2a, c2new],
        context: files,
        agents: ok,
      })!;
      expect(c2a.id).not.toBe(c1a.id);
      const states = Object.fromEntries(second.items.map((i) => [i.title, i.state]));
      expect(states).toEqual({
        "Missing await on save": "still_applicable",
        "Retry loop never stops": "resolved",
      });

      const afterC2 = [previousOf(c2a), previousOf(c2new)];
      const third = trackFindings({
        previous: { runId: "r2", headSha: "2".repeat(40), findings: afterC2 },
        current: [c2new],
        context: files,
        agents: ok,
      })!;
      const thirdStates = Object.fromEntries(third.items.map((i) => [i.title, i.state]));
      expect(thirdStates).toEqual({
        "Missing await on save": "resolved",
        "Token written to the log": "still_applicable",
      });
    });
  });
});
