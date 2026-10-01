import { describe, expect, it } from "vitest";
import { decide } from "../src/events/guards";
import { classifyEvent } from "../src/events/router";
import type { Classification } from "../src/events/types";
import { commentPayload, makeConfig, makePr, pullRequestPayload } from "./helpers";

function expectPr(c: Classification) {
  expect(c.kind).toBe("pr");
  if (c.kind !== "pr") throw new Error("unreachable");
  return c;
}

describe("classifyEvent: pull_request", () => {
  it.each(["opened", "reopened", "synchronize", "ready_for_review"])("handles %s", (action) => {
    const c = expectPr(
      classifyEvent({ eventName: "pull_request", payload: pullRequestPayload({ action }) }),
    );
    expect(c.trigger).toBe("pull_request");
    expect(c.pr).toEqual({
      number: 7,
      baseRef: "main",
      headSha: "abc1234",
      isDraft: false,
      isFork: false,
    });
  });

  it.each(["closed", "edited", "labeled", "converted_to_draft"])("ignores %s", (action) => {
    const c = classifyEvent({ eventName: "pull_request", payload: pullRequestPayload({ action }) });
    expect(c.kind).toBe("ignore");
  });

  it("detects a fork PR", () => {
    const c = expectPr(
      classifyEvent({
        eventName: "pull_request",
        payload: pullRequestPayload({ headRepo: "stranger/app" }),
      }),
    );
    expect(c.pr.isFork).toBe(true);
  });

  it("treats a deleted fork (null head repo) as a fork", () => {
    const c = expectPr(
      classifyEvent({
        eventName: "pull_request",
        payload: pullRequestPayload({ headRepo: null }),
      }),
    );
    expect(c.pr.isFork).toBe(true);
  });

  it("reads the draft flag", () => {
    const c = expectPr(
      classifyEvent({ eventName: "pull_request", payload: pullRequestPayload({ draft: true }) }),
    );
    expect(c.pr.isDraft).toBe(true);
  });

  it("ignores a malformed payload instead of throwing", () => {
    expect(classifyEvent({ eventName: "pull_request", payload: {} }).kind).toBe("ignore");
    expect(classifyEvent({ eventName: "pull_request", payload: null }).kind).toBe("ignore");
  });
});

describe("classifyEvent: workflow_dispatch", () => {
  it("needs a fetch for a valid pr_number", () => {
    expect(
      classifyEvent({ eventName: "workflow_dispatch", payload: {}, prNumberInput: " 42 " }),
    ).toEqual({ kind: "needs_fetch", trigger: "workflow_dispatch", prNumber: 42 });
  });

  it.each([undefined, "", "abc", "-3", "1.5", "0"])("ignores pr_number %j", (prNumberInput) => {
    const c = classifyEvent({
      eventName: "workflow_dispatch",
      payload: {},
      ...(prNumberInput === undefined ? {} : { prNumberInput }),
    });
    expect(c.kind).toBe("ignore");
  });
});

describe("classifyEvent: /ai-review comment command", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])("accepts a %s", (assoc) => {
    expect(
      classifyEvent({ eventName: "issue_comment", payload: commentPayload("/ai-review", assoc) }),
    ).toEqual({ kind: "needs_fetch", trigger: "comment_command", prNumber: 7 });
  });

  it("accepts leading whitespace and trailing text", () => {
    const c = classifyEvent({
      eventName: "issue_comment",
      payload: commentPayload("  /ai-review please", "MEMBER"),
    });
    expect(c.kind).toBe("needs_fetch");
  });

  it.each(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE", "MANNEQUIN"])(
    "ignores a %s",
    (assoc) => {
      const c = classifyEvent({
        eventName: "issue_comment",
        payload: commentPayload("/ai-review", assoc),
      });
      expect(c.kind).toBe("ignore");
    },
  );

  it("ignores comments without the command, on plain issues, and non-created actions", () => {
    expect(
      classifyEvent({ eventName: "issue_comment", payload: commentPayload("looks good", "OWNER") })
        .kind,
    ).toBe("ignore");
    expect(
      classifyEvent({
        eventName: "issue_comment",
        payload: commentPayload("/ai-review", "OWNER", false),
      }).kind,
    ).toBe("ignore");
    expect(
      classifyEvent({
        eventName: "issue_comment",
        payload: { ...commentPayload("/ai-review", "OWNER"), action: "edited" },
      }).kind,
    ).toBe("ignore");
  });
});

describe("classifyEvent: unsupported events", () => {
  it.each(["push", "schedule", "pull_request_target", "pull_request_review", "release"])(
    "ignores %s with a reason, not an error",
    (eventName) => {
      const c = classifyEvent({ eventName, payload: {} });
      expect(c.kind).toBe("ignore");
      if (c.kind === "ignore") expect(c.reason).toContain(eventName);
    },
  );
});

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
    for (const trigger of ["pull_request", "workflow_dispatch", "comment_command"] as const) {
      const d = decide(trigger, makePr({ isFork: true }), makeConfig());
      expect(d.action).toBe("skip");
      if (d.action === "skip") expect(d.reason).toContain("fork");
    }
  });

  it("still skips forks when fork_prs is read_only (deferred to Phase 9)", () => {
    const d = decide(
      "pull_request",
      makePr({ isFork: true }),
      makeConfig({ fork_prs: "read_only" }),
    );
    expect(d.action).toBe("skip");
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

  it("ready_for_review turns a former draft into a full review end to end", () => {
    const draft = expectPr(
      classifyEvent({
        eventName: "pull_request",
        payload: pullRequestPayload({ action: "opened", draft: true }),
      }),
    );
    const ready = expectPr(
      classifyEvent({
        eventName: "pull_request",
        payload: pullRequestPayload({ action: "ready_for_review", draft: false }),
      }),
    );
    expect(decide(draft.trigger, draft.pr, makeConfig())).toMatchObject({ depth: "summary_only" });
    expect(decide(ready.trigger, ready.pr, makeConfig())).toMatchObject({ depth: "full" });
  });

  it("carries the trigger through to the decision", () => {
    expect(decide("workflow_dispatch", makePr(), makeConfig())).toMatchObject({
      trigger: "workflow_dispatch",
    });
  });
});
