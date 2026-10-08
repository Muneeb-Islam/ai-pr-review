// Acceptance traceability (Phase 16): every acceptance criterion of docs/scope.md §7 and the automated tests that
// prove it. `traceability.test.ts` fails the build when a listed test is renamed or deleted, when a criterion has no
// test, and when docs/acceptance.md (generated from this file by `npm run acceptance:doc`) is out of date.
//
// `test` is the title (or a distinctive part of the title) of an `it(...)` or `describe(...)` in `file`.
// `real` says what automated tests cannot show: the part that only a real GitHub App, repository or provider can.

export interface Evidence {
  file: string;
  test: string;
}

export interface Criterion {
  id: number;
  text: string;
  evidence: Evidence[];
  /** What is left for the sandbox check or the pilot (docs/pilot.md). */
  real?: string;
}

export const CRITERIA: Criterion[] = [
  {
    id: 1,
    text: "A review triggers once per webhook event.",
    evidence: [
      {
        file: "acceptance/endToEnd.test.ts",
        test: "a new PR is a queued run with a queued Check Run",
      },
      {
        file: "apps/api/src/webhooks/webhooks.test.ts",
        test: "a second event for the same head creates no second run",
      },
      {
        file: "apps/worker/src/processor.test.ts",
        test: "processes a run once however many jobs arrive at the same time",
      },
    ],
    real: "Open a PR on the sandbox repository: exactly one run and one Check Run.",
  },
  {
    id: 2,
    text: "One structured summary comment, updated in place.",
    evidence: [
      {
        file: "packages/core/src/publisher/publish.test.ts",
        test: "the summary comment (FR-20, FR-21, FR-31, FR-32, AC-2)",
      },
      {
        file: "apps/worker/src/publisher.test.ts",
        test: "updates the same summary comment on a later run for the PR",
      },
      {
        file: "acceptance/endToEnd.test.ts",
        test: "the worker reviews it: one inline comment, one summary",
      },
    ],
  },
  {
    id: 3,
    text: "A high-confidence issue becomes an inline comment.",
    evidence: [
      {
        file: "packages/core/src/publisher/publish.test.ts",
        test: "the inline review (FR-17, FR-18, FR-33, AC-3)",
      },
      {
        file: "apps/worker/src/publisher.test.ts",
        test: "completes the Check Run, posts one review and one summary",
      },
    ],
    real: "GitHub accepts the review positions on a real diff (the sandbox check).",
  },
  {
    id: 4,
    text: "Low-confidence and info findings produce no inline comment.",
    evidence: [
      {
        file: "packages/core/src/publisher/publish.test.ts",
        test: "keeps lower items out of the inline review (AC-4)",
      },
      { file: "apps/worker/src/publisher.test.ts", test: "a review with no findings says so" },
    ],
  },
  {
    id: 5,
    text: "Missing tests are labelled as suggestions, never as measured coverage.",
    evidence: [
      {
        file: "packages/core/src/agents/testCoverage/testCoverage.test.ts",
        test: "Test Coverage agent: no coverage report (AC-5)",
      },
      {
        file: "apps/worker/src/coverage.test.ts",
        test: "completes with coverage not available when CI uploaded nothing",
      },
      {
        file: "apps/web/src/pages/runDetail.test.tsx",
        test: "labels a test suggestion as a suggestion, not a measurement",
      },
    ],
  },
  {
    id: 6,
    text: "LCOV coverage from a CI artifact is reported for the changed lines.",
    evidence: [
      {
        file: "packages/core/src/agents/testCoverage/testCoverage.test.ts",
        test: "Test Coverage agent: with a coverage artifact (AC-6)",
      },
      {
        file: "apps/worker/src/coverage.test.ts",
        test: "measures changed-line coverage from the artifact and stores it with the run",
      },
    ],
    real: "A coverage artifact uploaded by the sandbox repository's CI is found and read.",
  },
  {
    id: 7,
    text: "A critical security fixture reaches the summary and the Check Run.",
    evidence: [
      {
        file: "packages/core/src/agents/security/security.test.ts",
        test: "AC-7: a critical finding reaches the summary and the Check Run",
      },
      {
        file: "apps/worker/src/security.test.ts",
        test: "stores the finding, calls it out in the summary and the Check Run",
      },
    ],
  },
  {
    id: 8,
    text: "Invalid model output or a timeout gives a safe partial result.",
    evidence: [
      {
        file: "packages/core/src/agents/orchestrator.test.ts",
        test: "runReview: failure isolation (AC-8)",
      },
      {
        file: "apps/worker/src/hardening.test.ts",
        test: "a model that obeys completely and answers off-schema yields no findings",
      },
    ],
  },
  {
    id: 9,
    text: "Fork PRs never receive provider keys or execute code, and are skipped unless an administrator opts in.",
    evidence: [
      {
        file: "packages/core/src/sourceGuards.test.ts",
        test: "no repository code is ever executed or checked out (AC-9)",
      },
      {
        file: "packages/core/src/sourceGuards.test.ts",
        test: "fork pull requests are skipped unless an administrator opts in (AC-9)",
      },
      { file: "apps/worker/src/hardening.test.ts", test: "fork pull requests (AC-9, AC-23)" },
    ],
    real: "A PR from a fork of the sandbox repository is skipped with the reason.",
  },
  {
    id: 10,
    text: "A rerun on the same SHA adds no duplicate comments.",
    evidence: [
      {
        file: "acceptance/endToEnd.test.ts",
        test: "a re-run is a new run linked to the old one, and the second review adds no duplicate",
      },
      {
        file: "packages/core/src/publisher/publish.test.ts",
        test: "does not post a finding that was already posted for this head SHA",
      },
      {
        file: "packages/core/src/publisher/publish.test.ts",
        test: "also uses the markers GitHub already holds for this head SHA",
      },
    ],
  },
  {
    id: 11,
    text: "Ignored, generated and lock files are excluded and reported.",
    evidence: [
      {
        file: "packages/core/src/context/collect.test.ts",
        test: "collectContext: exclusions (FR-08, FR-10, AC-11)",
      },
    ],
  },
  {
    id: 12,
    text: "`fail_on_threshold` fails the check only at the threshold.",
    evidence: [
      { file: "acceptance/enforcement.test.ts", test: "the conclusion rule, mode by mode (AC-12)" },
      {
        file: "acceptance/enforcement.test.ts",
        test: "the same decision through the worker and the publisher (AC-12)",
      },
    ],
    real: "The check shows as failed on a sandbox PR with a planted bug, and the repository's required-check setting decides whether it blocks.",
  },
  {
    id: 13,
    text: "A webhook with an invalid or missing signature is rejected and creates nothing.",
    evidence: [
      { file: "apps/api/src/webhooks/webhooks.test.ts", test: "signature verification (AC-13)" },
      { file: "packages/core/src/github/webhook.test.ts", test: "webhook signature (AC-13)" },
    ],
  },
  {
    id: 14,
    text: "Redelivering a delivery ID creates no second run.",
    evidence: [
      {
        file: "apps/api/src/webhooks/webhooks.test.ts",
        test: "delivery recording and idempotency (AC-14)",
      },
      {
        file: "apps/api/src/hardening.test.ts",
        test: "the same 200 deliveries sent again create nothing new",
      },
    ],
  },
  {
    id: 15,
    text: "A push to an open PR supersedes the in-flight run; no stale inline comments are posted.",
    evidence: [
      {
        file: "apps/api/src/webhooks/webhooks.test.ts",
        test: "synchronize supersedes the older queued run for the same PR (AC-15)",
      },
      {
        file: "packages/db/src/supersede.test.ts",
        test: "supersedes older queued and running runs of the same PR",
      },
      {
        file: "apps/worker/src/publisher.test.ts",
        test: "a run superseded while it is reviewing posts nothing and closes its own Check Run",
      },
      {
        file: "apps/worker/src/publisher.test.ts",
        test: "a pull request that moved while the review ran: nothing is posted",
      },
    ],
  },
  {
    id: 16,
    text: "A new PR shows as pending in the dashboard and as a queued Check Run within about 5 seconds.",
    evidence: [
      {
        file: "apps/api/src/webhooks/webhooks.test.ts",
        test: "opened: creates a queued run with a queued Check Run and a job (AC-16)",
      },
      {
        file: "apps/web/src/hooks/useRunEvents.test.tsx",
        test: "a run changes status in the list without a page refresh (AC-16)",
      },
      {
        file: "acceptance/performance.test.ts",
        test: "webhook accepted -> run queued: p95 under 3 seconds",
      },
    ],
    real: "Stopwatch on the sandbox repository: PR opened -> queued Check Run and a pending row in the dashboard.",
  },
  {
    id: 17,
    text: "A signed-in user sees only the repositories they can access; others return 404/403.",
    evidence: [
      {
        file: "apps/api/src/authorization.test.ts",
        test: "a user of another tenant: 404, identical to a resource that does not exist",
      },
      {
        file: "apps/api/src/routes.test.ts",
        test: "the authorisation matrix covers every contract endpoint",
      },
      {
        file: "packages/db/src/rls.test.ts",
        test: "has a policy on every table that carries an installation id",
      },
      {
        file: "packages/db/src/isolation.test.ts",
        test: "has a case for every function the tenant layer exports",
      },
    ],
  },
  {
    id: 18,
    text: "Provider keys never appear in API responses, logs, prompts or posted comments, and are stored encrypted.",
    evidence: [
      {
        file: "apps/api/src/canary.test.ts",
        test: "the credential listing shows provider, last four characters and a time",
      },
      {
        file: "apps/worker/src/hardening.test.ts",
        test: "secrets in the repository and the pull request never reach the model, the logs, GitHub or the database",
      },
      {
        file: "apps/worker/src/hardening.test.ts",
        test: "the encrypted key in the database does not contain the plaintext",
      },
      {
        file: "apps/worker/src/publisher.test.ts",
        test: "never posts a planted secret, and never logs it",
      },
      {
        file: "packages/core/src/crypto/envelope.test.ts",
        test: "never stores the secret in the clear",
      },
    ],
  },
  {
    id: 19,
    text: "Finding feedback is persisted and changes the analytics metrics.",
    evidence: [
      { file: "apps/api/src/insights.test.ts", test: "changes when feedback is given (AC-19)" },
      {
        file: "acceptance/endToEnd.test.ts",
        test: "feedback is stored and moves the analytics (AC-19)",
      },
    ],
  },
  {
    id: 20,
    text: "Run history stays filterable and complete for the retention window; cleanup removes older data.",
    evidence: [
      {
        file: "apps/worker/src/retention.test.ts",
        test: "removes a run's agent runs, findings, comments and feedback together, in one pass (AC-20)",
      },
      {
        file: "apps/api/src/runs.test.ts",
        test: "filters by status, a list of statuses, branch, author and severity",
      },
      { file: "apps/api/src/runs.test.ts", test: "filters by the time the run was queued" },
    ],
  },
  {
    id: 21,
    text: "Re-run from the dashboard creates a linked new run for the same PR and head SHA.",
    evidence: [
      {
        file: "apps/api/src/runActions.test.ts",
        test: "queues a new run linked to the old one, for the commit the pull request points at now",
      },
      { file: "acceptance/endToEnd.test.ts", test: "a re-run is a new run linked to the old one" },
    ],
  },
  {
    id: 22,
    text: "Uninstalling the App deactivates the installation: no runs, data hidden, retention applies.",
    evidence: [
      {
        file: "apps/api/src/hardening.test.ts",
        test: "uninstall: stops what was waiting, forgets the keys and who could see the data",
      },
      {
        file: "apps/worker/src/retention.test.ts",
        test: "purges an installation uninstalled longer ago than the window",
      },
    ],
    real: "Uninstall the App from the sandbox repository: the dashboard hides it and a new PR creates no run.",
  },
  {
    id: 23,
    text: "Quotas stop new runs when a per-installation limit is exceeded and record a skipped run with the reason.",
    evidence: [
      {
        file: "apps/api/src/hardening.test.ts",
        test: "the daily quota stops new runs and records a skipped run with the reason",
      },
      {
        file: "apps/api/src/hardening.test.ts",
        test: "the queue limit of an installation skips the run that would be one too many",
      },
      {
        file: "packages/core/src/providers/providers.test.ts",
        test: "stops starting requests once the token budget is spent",
      },
    ],
  },
];

/** docs/acceptance.md, generated. */
export function renderTraceability(): string {
  const lines: string[] = [
    "# Acceptance criteria and the tests behind them",
    "",
    "<!-- Generated by `npm run acceptance:doc` from acceptance/traceability.ts. Do not edit by hand. -->",
    "",
    "Every acceptance criterion of [scope.md](scope.md) §7 (AC-1 to AC-12 come from the PRD, AC-13 to AC-23 from the scope) with the automated tests that prove it. `npm run acceptance` runs the suite written for Phase 16 (`acceptance/`); `npm test` runs it with everything else, in CI on every change. A test that is renamed or deleted fails `acceptance/traceability.test.ts`, so this list cannot go stale.",
    "",
    "The tests use a mock provider and in-memory GitHub, with a real PostgreSQL and the real api, worker and publisher. What they cannot show is what only a real GitHub App, repository or AI provider does; the **Real GitHub** line under a criterion says what to look at in the sandbox check or the pilot ([pilot.md](pilot.md)).",
    "",
  ];
  for (const c of CRITERIA) {
    lines.push(`## AC-${c.id}`, "", c.text, "");
    for (const e of c.evidence) lines.push(`- \`${e.file}\`: ${e.test}`);
    lines.push("");
    if (c.real) lines.push(`**Real GitHub:** ${c.real}`, "");
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}
