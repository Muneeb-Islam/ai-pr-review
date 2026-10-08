// UI-04: the run detail page for every status, with its sections, links, and failure states.
import { RUN_STATUSES } from "@ai-pr-review/shared/api";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { STATUS_LABELS } from "../lib/format";
import { API, makeDetail, makeFinding, type RunDetailDto } from "../test/fixtures";
import { apiError, json, renderApp, signedInAs } from "../test/render";
import { server } from "../test/server";

const T0 = Date.parse("2026-10-05T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

function serveRun(run: RunDetailDto) {
  signedInAs();
  server.use(http.get(`${API}/api/runs/${run.id}`, () => json(run)));
  return renderApp(`/runs/${run.id}`);
}

/** A run in each status with the timestamps that status really has. */
function runIn(status: (typeof RUN_STATUSES)[number]): RunDetailDto {
  const base = { id: `run-${status}`, status, queued_at: at(0) };
  switch (status) {
    case "queued":
      return makeDetail({ ...base, started_at: null, finished_at: null, agent_runs: [] });
    case "running":
      return makeDetail({
        ...base,
        started_at: at(5_000),
        finished_at: null,
        agent_runs: [],
      });
    case "skipped":
      return makeDetail({
        ...base,
        started_at: null,
        finished_at: at(1_000),
        status_reason: "Draft pull request",
        agent_runs: [],
      });
    case "superseded":
    case "cancelled":
      return makeDetail({
        ...base,
        started_at: null,
        finished_at: at(2_000),
        status_reason: status === "superseded" ? "Superseded by run abc" : "Cancelled by a user",
        agent_runs: [],
      });
    case "failed":
      return makeDetail({
        ...base,
        started_at: at(4_000),
        finished_at: at(9_000),
        status_reason: "No provider key is configured",
        agent_runs: [],
      });
    default:
      return makeDetail({ ...base, started_at: at(4_000), finished_at: at(64_000) });
  }
}

describe.each(RUN_STATUSES)("Run detail, status %s", (status) => {
  it("shows the status as a word, the timeline and the details", async () => {
    serveRun(runIn(status));
    const heading = await screen.findByRole("heading", { level: 1 });
    const badge = within(heading.parentElement!).getByText(STATUS_LABELS[status]);
    expect(badge.closest("[data-status]")).toHaveAttribute("data-status", status);

    const timeline = screen.getByRole("list", { name: "Run timeline" });
    expect(within(timeline).getByText("Queued")).toBeVisible();
    if (status === "queued") {
      expect(within(timeline).getByText("Waiting for a worker")).toBeVisible();
    }
    if (status === "running") {
      expect(within(timeline).getByText(/Running for/)).toBeVisible();
    }
    if (status === "skipped") {
      expect(within(timeline).getByText(/Draft pull request/)).toBeVisible();
      expect(within(timeline).queryByText("Started")).toBeNull();
    }
    if (status === "completed" || status === "partial") {
      expect(within(timeline).getByText(/Took 1 m/)).toBeVisible();
      expect(within(timeline).getByText(/Waited 4 s for a worker/)).toBeVisible();
    }
    expect(screen.getByRole("heading", { name: "Details" })).toBeVisible();
  });
});

describe("Run detail content", () => {
  it("links to the pull request and the Check Run on GitHub, safely", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        pr_url: "https://github.com/acme/api/pull/7",
        check_run_url: "https://github.com/acme/api/runs/4711",
      }),
    );
    const pr = await screen.findByRole("link", { name: /acme\/api#\d+/ });
    expect(pr).toHaveAttribute("href", "https://github.com/acme/api/pull/7");
    expect(pr).toHaveAttribute("target", "_blank");
    expect(pr).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: /view on github/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/api/runs/4711",
    );
  });

  it("says when there is no Check Run yet", async () => {
    serveRun(makeDetail({ id: "run-1", check_run_url: null }));
    expect(await screen.findByText("None yet")).toBeVisible();
  });

  it("shows trigger, who triggered it, base branch and shortened commits", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        trigger: "dashboard_rerun",
        triggered_by: "hubot",
        base_ref: "release",
        head_sha: "1234567890abcdef".padEnd(40, "0"),
        base_sha: "fedcba0987654321".padEnd(40, "0"),
      }),
    );
    const details = (await screen.findByRole("heading", { name: "Details" })).closest("section")!;
    expect(within(details).getByText("Dashboard re-run by hubot")).toBeVisible();
    expect(within(details).getByText("release")).toBeVisible();
    expect(within(details).getByText("1234567")).toHaveAttribute(
      "title",
      expect.stringMatching(/^1234567890abcdef/),
    );
    expect(within(details).getByText("fedcba0")).toBeVisible();
  });

  it("links a re-run to the run it repeats", async () => {
    serveRun(makeDetail({ id: "run-2", parent_run_id: "run-1" }));
    expect(await screen.findByRole("link", { name: "Earlier run" })).toHaveAttribute(
      "href",
      "/runs/run-1",
    );
  });

  it("lists each agent with status, duration, tokens, retries and warnings", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        agent_runs: [
          {
            agent: "code_review",
            status: "ok",
            started_at: at(1_000),
            duration_ms: 31_000,
            input_tokens: 12_345,
            output_tokens: 678,
            retries: 0,
            warnings: [],
          },
          {
            agent: "test_coverage",
            status: "timeout",
            started_at: at(1_000),
            duration_ms: 120_000,
            input_tokens: 500,
            output_tokens: 0,
            retries: 2,
            warnings: ["The agent did not finish in time"],
          },
        ],
      }),
    );
    const table = await screen.findByRole("table", { name: /agents that ran/i });
    const [codeReview, coverage] = within(table).getAllByRole("row").slice(1);
    expect(within(codeReview!).getByText("Code Review")).toBeVisible();
    expect(within(codeReview!).getByText("OK")).toBeVisible();
    expect(within(codeReview!).getByText("31 s")).toBeVisible();
    expect(within(codeReview!).getByText("12,345 / 678")).toBeVisible();
    expect(within(coverage!).getByText("Timed out")).toBeVisible();
    expect(within(coverage!).getByText("2 m")).toBeVisible();
    expect(within(coverage!).getByText("The agent did not finish in time")).toBeVisible();
  });

  it("lists findings with severity, location and, when opened, the evidence and advice", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        finding_counts: { critical: 1, high: 0, medium: 0, low: 0, info: 1 },
        findings: [
          makeFinding({
            severity: "critical",
            title: "SQL built from request input",
            file_path: "src/db.ts",
            start_line: 40,
            end_line: 44,
            evidence: "query = 'select * from t where id=' + id",
            suggested_test: "Call it with a quote in the id",
          }),
          makeFinding({
            severity: "info",
            title: "Repository-wide note",
            file_path: null,
            start_line: null,
            end_line: null,
          }),
        ],
      }),
    );
    const section = (await screen.findByRole("heading", { name: "Findings (2)" })).closest(
      "section",
    )!;
    const [first, second] = within(section).getAllByRole("listitem");
    expect(within(first!).getByText("Critical")).toBeVisible();
    expect(within(first!).getByText("SQL built from request input")).toBeVisible();
    expect(within(first!).getByText("src/db.ts:40–44")).toBeVisible();
    expect(within(second!).getByText("General")).toBeVisible();

    // The details are folded away until asked for.
    expect(within(first!).getByText(/select \* from t/)).not.toBeVisible();
    await userEvent.setup().click(within(first!).getByText("SQL built from request input"));
    expect(within(first!).getByText(/select \* from t/)).toBeVisible();
    expect(within(first!).getByText("Call it with a quote in the id")).toBeVisible();
    expect(within(first!).getByText("Inline comment posted")).toBeVisible();
  });

  it("shows model-written text as text, never as markup", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        findings: [
          makeFinding({
            title: '<img src=x onerror="alert(1)"> injected',
            evidence: "<script>alert(2)</script>",
          }),
        ],
      }),
    );
    expect(await screen.findByText(/injected/)).toBeVisible();
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert(2)</script>")).toBeInTheDocument();
  });

  it("says plainly when a finished review found nothing", async () => {
    serveRun(makeDetail({ id: "run-1", status: "completed", findings: [] }));
    expect(await screen.findByText("The review found nothing to report.")).toBeVisible();
  });

  it("shows warnings, suppressed counts, skipped files and usage", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        status: "partial",
        warnings: ["Test Coverage timed out", "3 files were left out of the review"],
        suppressed_counts: { below_threshold: 2, duplicate: 1 },
        skipped_files: [
          { path: "package-lock.json", reason: "lockfile" },
          { path: "dist/app.js", reason: "build output" },
        ],
        usage: { input_tokens: 123_456, output_tokens: 7_890 },
      }),
    );
    const warnings = (await screen.findByRole("heading", { name: "Warnings" })).closest("section")!;
    expect(within(warnings).getByText("Test Coverage timed out")).toBeVisible();
    expect(within(warnings).getByText("3 files were left out of the review")).toBeVisible();

    expect(screen.getByText(/Not shown: 2 below the thresholds, 1 duplicates\./)).toBeVisible();

    const skipped = screen.getByRole("heading", { name: "Skipped files (2)" }).closest("section")!;
    expect(within(skipped).getByText("package-lock.json")).toBeVisible();
    expect(within(skipped).getByText("lockfile")).toBeVisible();

    const usage = screen.getByRole("heading", { name: "Usage" }).closest("section")!;
    expect(within(usage).getByText("123,456")).toBeVisible();
    expect(within(usage).getByText("7,890")).toBeVisible();
    expect(within(usage).getByText("131,346")).toBeVisible();
  });

  it("says when nothing was skipped and no warnings exist", async () => {
    serveRun(makeDetail({ id: "run-1" }));
    expect(await screen.findByText("Every changed file was reviewed.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Warnings" })).toBeNull();
  });
});

describe("Run detail failures", () => {
  it("says a run is not found (also what another tenant's run looks like)", async () => {
    signedInAs();
    server.use(http.get(`${API}/api/runs/nope`, () => apiError(404, "not_found", "Not found")));
    renderApp("/runs/nope");
    expect(await screen.findByRole("heading", { name: "Run not found" })).toBeVisible();
    expect(screen.getByRole("link", { name: /all runs/i })).toHaveAttribute("href", "/runs");
  });

  it("shows other errors with a retry", async () => {
    signedInAs();
    let fail = true;
    const run = makeDetail({ id: "run-1" });
    server.use(
      http.get(`${API}/api/runs/run-1`, () => (fail ? apiError(500, "internal_error") : json(run))),
    );
    renderApp("/runs/run-1");
    expect(await screen.findByRole("alert")).toBeVisible();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Details" })).toBeVisible();
  });

  it("shows a loading state first", async () => {
    signedInAs();
    const run = makeDetail({ id: "run-1" });
    server.use(
      http.get(`${API}/api/runs/run-1`, async () => {
        await new Promise((r) => setTimeout(r, 100));
        return json(run);
      }),
    );
    renderApp("/runs/run-1");
    expect(await screen.findByText("Loading run…")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Details" })).toBeVisible();
  });
});

type CoverageDto = NonNullable<RunDetailDto["coverage"]>;

const measuredCoverage = (over: Partial<CoverageDto> = {}): CoverageDto => ({
  status: "measured",
  reason: null,
  reason_code: null,
  changed_line_coverage: 0.6,
  covered_lines: 3,
  total_lines: 5,
  artifact_name: "coverage",
  artifact_run_id: 31,
  observations: [],
  files: [
    {
      path: "src/orders.ts",
      status: "measured",
      covered_lines: 3,
      total_lines: 5,
      uncovered: [
        { start: 12, end: 14 },
        { start: 30, end: 30 },
      ],
      uncovered_functions: ["refund"],
      covered_branches: null,
      total_branches: null,
    },
    {
      path: "src/new.ts",
      status: "not_in_report",
      covered_lines: 0,
      total_lines: 0,
      uncovered: [],
      uncovered_functions: [],
      covered_branches: null,
      total_branches: null,
    },
  ],
  ...over,
});

describe("Run detail: coverage (FR-22, FR-23, AC-6)", () => {
  it("shows the measured percentage, the source of the report and each file's uncovered lines", async () => {
    serveRun(makeDetail({ id: "run-1", coverage: measuredCoverage() }));
    const section = (await screen.findByRole("heading", { name: "Coverage" })).closest("section")!;
    expect(within(section).getByTestId("coverage-percent")).toHaveTextContent("60%");
    expect(within(section).getByText(/of changed lines covered \(3 of 5 executable/)).toBeVisible();
    expect(within(section).getByRole("link", { name: /workflow run/i })).toHaveAttribute(
      "href",
      "https://github.com/acme/api/actions/runs/31",
    );

    const table = within(section).getByRole("table", { name: /coverage of the changed lines/i });
    const [measured, unknown] = within(table).getAllByRole("row").slice(1);
    expect(within(measured!).getByText("src/orders.ts")).toBeVisible();
    expect(within(measured!).getByText("60%")).toBeVisible();
    expect(within(measured!).getByText("12–14, 30")).toBeVisible();
    expect(within(measured!).getByText("refund")).toBeVisible();
    // A file missing from the report is unknown, never shown as 0%.
    expect(within(unknown!).getByText("src/new.ts")).toBeVisible();
    expect(
      within(unknown!).getByText(/not in the report, so its coverage is unknown/i),
    ).toBeVisible();
    expect(within(unknown!).queryByText(/0%/)).toBeNull();
    expect(within(section).getByText(/1 file has changed lines that never ran/)).toBeVisible();
  });

  it("says that coverage could not be measured, why, and that suggestions come from the diff", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        coverage: {
          status: "not_available",
          reason: "CI was still running when the review started, so no coverage report was ready.",
          reason_code: "ci_running",
          changed_line_coverage: null,
          covered_lines: null,
          total_lines: null,
          files: [],
          artifact_name: null,
          artifact_run_id: null,
          observations: [],
        },
      }),
    );
    const section = (await screen.findByRole("heading", { name: "Coverage" })).closest("section")!;
    expect(within(section).getByText("Coverage could not be measured.")).toBeVisible();
    expect(within(section).getByText(/CI was still running/)).toBeVisible();
    expect(within(section).getByText(/not from a coverage report/)).toBeVisible();
    expect(within(section).queryByTestId("coverage-percent")).toBeNull();
    expect(within(section).queryByRole("table")).toBeNull();
  });

  it("has no coverage section when the agent did not run", async () => {
    serveRun(makeDetail({ id: "run-1", coverage: null }));
    await screen.findByRole("heading", { name: "Details" });
    expect(screen.queryByRole("heading", { name: "Coverage" })).toBeNull();
  });

  it("labels a test suggestion as a suggestion, not a measurement (AC-5)", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        findings: [
          makeFinding({
            agent: "test_coverage",
            category: "test_gap",
            severity: "medium",
            title: "Missing test: negative price is rejected",
            suggested_test: "Target: applyDiscount. Scenario: a negative price. Assert: it throws.",
          }),
        ],
      }),
    );
    expect(
      await screen.findByText(/Suggested missing test \(from reading the diff, not measured\)/),
    ).toBeInTheDocument();
  });
});

const securityAgent = (status: "ok" | "failed" | "timeout" | "invalid_output" = "ok") => ({
  agent: "security" as const,
  status,
  started_at: at(1_000),
  duration_ms: 9_000,
  input_tokens: 800,
  output_tokens: 120,
  retries: 0,
  warnings: [],
});

const securityFinding = (over: Partial<RunDetailDto["findings"][number]> = {}) =>
  makeFinding({
    agent: "security",
    category: "security",
    severity: "critical",
    confidence: 0.96,
    title: "SQL query built from request data on a public route",
    file_path: "src/routes/users.ts",
    start_line: 8,
    end_line: 8,
    ...over,
  });

describe("Run detail: security (FR-28)", () => {
  it("highlights high-confidence critical and high findings with an overall status and the advisory note", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        agent_runs: [securityAgent()],
        findings: [
          securityFinding(),
          securityFinding({ id: "f-high", severity: "high", title: "Order deletion has no auth" }),
          securityFinding({ id: "f-low", severity: "medium", title: "Verbose error responses" }),
          makeFinding({ title: "Off-by-one in a loop" }),
        ],
      }),
    );
    const panel = await screen.findByTestId("security-panel");
    expect(panel).toHaveAttribute("data-level", "attention");
    expect(within(panel).getByRole("heading", { name: "Security" })).toBeVisible();
    expect(
      within(panel).getByText("Attention needed: 1 critical, 1 high security findings."),
    ).toBeVisible();
    const callouts = within(panel).getByRole("list", {
      name: "Security findings that need attention",
    });
    expect(within(callouts).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(callouts).getByText("SQL query built from request data on a public route"),
    ).toBeVisible();
    expect(within(callouts).queryByText("Verbose error responses")).toBeNull();
    expect(
      within(panel).getByText(/not a replacement for SAST or dependency scanning/),
    ).toBeVisible();
  });

  it("marks security findings in the list and calls the advice a mitigation", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        agent_runs: [securityAgent()],
        findings: [securityFinding(), makeFinding({ title: "Off-by-one in a loop" })],
      }),
    );
    const section = (await screen.findByRole("heading", { name: "Findings (2)" })).closest(
      "section",
    )!;
    const items = within(section).getAllByRole("listitem");
    const security = items.find((li) => li.getAttribute("data-category") === "security")!;
    const bug = items.find((li) => li.getAttribute("data-category") === "bug")!;
    expect(within(security.querySelector("summary")!).getByText("Security")).toBeVisible();
    expect(within(security).getByText("Mitigation")).toBeInTheDocument();
    expect(within(bug).queryByText("Mitigation")).toBeNull();
    expect(within(bug).getByText("Recommendation")).toBeInTheDocument();
  });

  it("filters the findings by category, in the address too", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        agent_runs: [securityAgent()],
        findings: [
          securityFinding(),
          securityFinding({
            id: "f2",
            severity: "medium",
            title: "Cookie without the secure flag",
          }),
          makeFinding({ title: "Off-by-one in a loop" }),
          makeFinding({
            category: "test_gap",
            agent: "test_coverage",
            title: "Missing test: refund",
          }),
        ],
      }),
    );
    const user = userEvent.setup();
    const filter = await screen.findByRole("group", { name: "Filter findings by category" });
    expect(within(filter).getByRole("button", { name: "All (4)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(filter).getByRole("button", { name: "Security (2)" }));

    const section = screen.getByRole("heading", { name: /Findings/ }).closest("section")!;
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    expect(within(section).queryByText("Off-by-one in a loop")).toBeNull();
    expect(within(filter).getByRole("button", { name: "Security (2)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(within(filter).getByRole("button", { name: "All (4)" }));
    expect(within(section).getAllByRole("listitem")).toHaveLength(4);
  });

  it("opens with the filter taken from the address and ignores a category the run does not have", async () => {
    const run = makeDetail({
      id: "run-1",
      agent_runs: [securityAgent()],
      findings: [securityFinding(), makeFinding({ title: "Off-by-one in a loop" })],
    });
    signedInAs();
    server.use(http.get(`${API}/api/runs/run-1`, () => json(run)));
    renderApp("/runs/run-1?category=security");
    const section = (await screen.findByRole("heading", { name: /Findings/ })).closest("section")!;
    expect(within(section).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(section).getByText("SQL query built from request data on a public route"),
    ).toBeVisible();
  });

  it("offers no filter when every finding is in one category", async () => {
    serveRun(makeDetail({ id: "run-1", findings: [makeFinding(), makeFinding()] }));
    await screen.findByRole("heading", { name: "Findings (2)" });
    expect(screen.queryByRole("group", { name: "Filter findings by category" })).toBeNull();
  });

  it("says a finished review with no security findings found none, without calling the change safe", async () => {
    serveRun(makeDetail({ id: "run-1", agent_runs: [securityAgent()], findings: [] }));
    const panel = await screen.findByTestId("security-panel");
    expect(panel).toHaveAttribute("data-level", "clear");
    expect(within(panel).getByText("No security findings reported.")).toBeVisible();
  });

  it("does not read a failed security review as a clean result", async () => {
    serveRun(makeDetail({ id: "run-1", agent_runs: [securityAgent("timeout")], findings: [] }));
    const panel = await screen.findByTestId("security-panel");
    expect(panel).toHaveAttribute("data-level", "incomplete");
    expect(within(panel).getByText(/No finding does not mean the change is safe/)).toBeVisible();
  });

  it("only mentions medium findings as other findings", async () => {
    serveRun(
      makeDetail({
        id: "run-1",
        agent_runs: [securityAgent()],
        findings: [securityFinding({ severity: "medium", title: "Verbose errors" })],
      }),
    );
    const panel = await screen.findByTestId("security-panel");
    expect(panel).toHaveAttribute("data-level", "findings");
    expect(within(panel).getByText(/1 other security finding listed below/)).toBeVisible();
  });

  it("shows no security section for a run the Security agent took no part in", async () => {
    serveRun(makeDetail({ id: "run-1" }));
    await screen.findByRole("heading", { name: "Agents" });
    expect(screen.queryByTestId("security-panel")).toBeNull();
  });
});
