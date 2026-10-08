import { RUN_STATUSES, SEVERITIES } from "@ai-pr-review/shared/api";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { STATUS_LABELS } from "../lib/format";
import { RelativeTime } from "./RelativeTime";
import { SeverityBadge, SeverityCounts } from "./SeverityBadge";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it.each(RUN_STATUSES)("%s is shown as words, not only a colour", (status) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByText(STATUS_LABELS[status]);
    expect(badge).toBeVisible();
    expect(badge.closest("[data-status]")).toHaveAttribute("data-status", status);
  });

  it("has a distinct label for every status", () => {
    const labels = RUN_STATUSES.map((s) => STATUS_LABELS[s]);
    expect(new Set(labels).size).toBe(RUN_STATUSES.length);
  });

  it("hides the decorative icon from assistive technology", () => {
    const { container } = render(<StatusBadge status="running" />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("SeverityBadge", () => {
  it.each(SEVERITIES)("%s has a text label", (severity) => {
    render(<SeverityBadge severity={severity} />);
    expect(screen.getByText(new RegExp(`^${severity}$`, "i"))).toBeVisible();
  });
});

describe("SeverityCounts", () => {
  it("lists the findings most severe first", () => {
    render(<SeverityCounts counts={{ critical: 1, high: 0, medium: 3, low: 0, info: 2 }} />);
    expect(screen.getByText("1 critical · 3 medium · 2 info")).toBeVisible();
  });

  it("says so when there are none", () => {
    render(<SeverityCounts counts={{ critical: 0, high: 0, medium: 0, low: 0, info: 0 }} />);
    expect(screen.getByText("No findings")).toBeVisible();
  });
});

describe("RelativeTime", () => {
  it("shows the exact time on hover and a machine-readable datetime", () => {
    const iso = new Date(Date.now() - 5 * 60_000).toISOString();
    render(<RelativeTime iso={iso} />);
    const time = screen.getByText("5 minutes ago");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", iso);
    expect(time.getAttribute("title")).toMatch(/2026/);
  });
});
