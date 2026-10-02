import { describe, expect, it } from "vitest";
import { decide } from "./guards";
import { makeConfig, makePr } from "./test-helpers";

describe("decide: target-branch guard", () => {
  it.each(["main", "master"])("reviews PRs into %s by default", (baseRef) => {
    const d = decide("pull_request", makePr({ baseRef }), makeConfig());
    expect(d.action).toBe("review");
  });

  it("skips other branches with a log reason", () => {
    const d = decide("pull_request", makePr({ baseRef: "develop" }), makeConfig());
    expect(d.action).toBe("skip");
    if (d.action === "skip") expect(d.reason).toContain("develop");
  });

  it("honours a custom review.target_branches", () => {
    const cfg = makeConfig({ review: { target_branches: ["release"] } });
    expect(decide("pull_request", makePr({ baseRef: "release" }), cfg).action).toBe("review");
    expect(decide("pull_request", makePr({ baseRef: "main" }), cfg).action).toBe("skip");
  });
});

describe("decide: fork guard", () => {
  it("skips fork PRs for every trigger", () => {
    for (const trigger of [
      "pull_request",
      "comment_command",
      "check_run_rerequested",
      "dashboard_rerun",
    ] as const) {
      const d = decide(trigger, makePr({ isFork: true }), makeConfig());
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toContain("fork");
    }
  });

  it("skips forks when fork_prs is explicitly skip", () => {
    const d = decide("pull_request", makePr({ isFork: true }), makeConfig({ fork_prs: "skip" }));
    expect(d.action).toBe("skip");
  });

  it("reviews forks when fork_prs is review", () => {
    const d = decide("pull_request", makePr({ isFork: true }), makeConfig({ fork_prs: "review" }));
    expect(d).toMatchObject({ action: "review", depth: "full" });
  });

  it("still applies the branch and draft rules to an allowed fork", () => {
    const cfg = makeConfig({ fork_prs: "review" });
    expect(decide("pull_request", makePr({ isFork: true, baseRef: "develop" }), cfg).action).toBe(
      "skip",
    );
    expect(decide("pull_request", makePr({ isFork: true, isDraft: true }), cfg)).toMatchObject({
      depth: "summary_only",
    });
  });

  it("checks the fork before anything else", () => {
    const d = decide("pull_request", makePr({ isFork: true, baseRef: "develop" }), makeConfig());
    expect(d.action === "skip" && d.reason.includes("fork")).toBe(true);
  });
});

describe("decide: draft vs ready", () => {
  it("a ready PR gets a full review", () => {
    expect(decide("pull_request", makePr(), makeConfig())).toMatchObject({
      action: "review",
      depth: "full",
    });
  });

  it("a draft PR is summary-only by default", () => {
    expect(decide("pull_request", makePr({ isDraft: true }), makeConfig())).toMatchObject({
      action: "review",
      depth: "summary_only",
    });
  });

  it("draft_behavior: full reviews drafts fully", () => {
    const cfg = makeConfig({ review: { draft_behavior: "full" } });
    expect(decide("pull_request", makePr({ isDraft: true }), cfg)).toMatchObject({ depth: "full" });
  });

  it("draft_behavior: skip skips drafts", () => {
    const cfg = makeConfig({ review: { draft_behavior: "skip" } });
    expect(decide("pull_request", makePr({ isDraft: true }), cfg).action).toBe("skip");
  });

  it("the same PR is summary-only while draft and full once ready", () => {
    expect(decide("pull_request", makePr({ isDraft: true }), makeConfig())).toMatchObject({
      depth: "summary_only",
    });
    expect(decide("pull_request", makePr({ isDraft: false }), makeConfig())).toMatchObject({
      depth: "full",
    });
  });

  it("carries the trigger through to the decision", () => {
    expect(decide("dashboard_rerun", makePr(), makeConfig())).toMatchObject({
      trigger: "dashboard_rerun",
    });
  });
});
