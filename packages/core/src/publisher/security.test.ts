import type { Finding } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { makeFinding } from "../agents/test-support";
import { securityStatus } from "./security";

const sec = (over: Partial<Finding> = {}): Finding =>
  makeFinding({ agent: "security", category: "security", ...over });

describe("securityStatus (FR-28)", () => {
  it("needs attention for a high-confidence critical or high finding, critical first", () => {
    const status = securityStatus(
      [
        sec({ id: "a", severity: "high", confidence: 0.85 }),
        sec({ id: "b", severity: "critical", confidence: 0.9 }),
        sec({ id: "c", severity: "high", confidence: 0.95 }),
      ],
      "ok",
    );
    expect(status).toMatchObject({ level: "attention", critical: 1, high: 2, total: 3 });
    expect(status.callouts.map((f) => f.id)).toEqual(["b", "c", "a"]);
    expect(status.text).toBe("Attention needed: 1 critical, 2 high security findings.");
  });

  it("singular wording", () => {
    expect(securityStatus([sec({ severity: "high" })], "ok").text).toBe(
      "Attention needed: 1 high security finding.",
    );
  });

  it("does not call out a critical or high finding the agent is not sure about", () => {
    const status = securityStatus([sec({ severity: "critical", confidence: 0.7 })], "ok");
    expect(status.level).toBe("findings");
    expect(status.callouts).toEqual([]);
  });

  it("ignores findings of other agents and categories", () => {
    const status = securityStatus(
      [makeFinding({ severity: "critical" }), sec({ severity: "low" })],
      "ok",
    );
    expect(status).toMatchObject({ level: "findings", total: 1 });
  });

  it("is clear only when the agent finished and found nothing", () => {
    expect(securityStatus([], "ok")).toMatchObject({
      level: "clear",
      text: "No security findings reported.",
    });
  });

  it.each(["failed", "timeout", "invalid_output"] as const)(
    "is incomplete, not clear, when the agent ended as %s",
    (state) => {
      const status = securityStatus([], state);
      expect(status.level).toBe("incomplete");
      expect(status.text).toContain("No finding does not mean the change is safe.");
    },
  );

  it("still calls out a finding when the agent did not finish, and says there may be more", () => {
    const status = securityStatus([sec({ severity: "high" })], "timeout");
    expect(status.level).toBe("attention");
    expect(status.text).toContain("did not finish, so there may be more");
  });

  it("reports an agent that did not run or is off", () => {
    expect(securityStatus([], "not_run").level).toBe("not_run");
    expect(securityStatus([], "not_available").level).toBe("not_run");
    expect(securityStatus([], "off").level).toBe("off");
  });
});
