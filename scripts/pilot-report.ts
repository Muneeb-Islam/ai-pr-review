// `npm run pilot:report -- [--days 28] [--from 2026-10-01] [--to 2026-10-29] [--provider deepseek]`
//
// Prints the pilot report (docs/pilot.md) for every active installation in DATABASE_URL: the PRD §13 metrics as
// counts and percentages with their verdicts, and token use by size of review. It reads the same numbers the
// dashboard's Analytics screen shows (`analyticsSummary`), so the two always agree. Read-only.
import { parseArgs } from "node:util";
import { analyticsSummary, createDb } from "@ai-pr-review/db";
import { loadEnv, PROVIDERS, serverEnvShape } from "@ai-pr-review/shared";
import { z } from "zod";
import { estimateCostUsd, type ProviderName } from "../apps/api/src/analytics/pricing";
import { renderPilotReport, type SizeClassUsage } from "./lib/pilotReport";

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "28" },
    from: { type: "string" },
    to: { type: "string" },
    provider: { type: "string", default: "deepseek" },
  },
});
const provider = values.provider as ProviderName;
if (!(PROVIDERS as readonly string[]).includes(provider)) {
  process.stderr.write(`--provider must be one of ${PROVIDERS.join(", ")}\n`);
  process.exit(1);
}
const to = values.to ? new Date(values.to) : new Date();
const from = values.from
  ? new Date(values.from)
  : new Date(to.getTime() - Number(values.days) * 86_400_000);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
  process.stderr.write("--from and --to must be dates such as 2026-10-01\n");
  process.exit(1);
}

const { DATABASE_URL } = loadEnv(z.object({ DATABASE_URL: serverEnvShape.DATABASE_URL }));
const handle = createDb(DATABASE_URL, { max: 1 });

const CLASSES = [
  { label: "under 10,000", min: 0, max: 10_000 },
  { label: "10,000 to 50,000", min: 10_000, max: 50_000 },
  { label: "over 50,000", min: 50_000, max: Infinity },
];
const median = (numbers: number[]): number => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

try {
  const installationIds = (
    await handle.pool.query<{ id: string }>("select id from installations where status = 'active'")
  ).rows.map((r) => r.id);
  const repoIds = (
    await handle.pool.query<{ id: string }>(
      "select id from repositories where installation_id = any($1::uuid[]) and active",
      [installationIds],
    )
  ).rows.map((r) => r.id);

  const s = await analyticsSummary(handle.db, installationIds, { repoIds, from, to });

  const runs = (
    await handle.pool.query<{ input: string; output: string }>(
      `select coalesce((usage->>'inputTokens')::bigint, 0) as input,
              coalesce((usage->>'outputTokens')::bigint, 0) as output
         from review_runs
        where installation_id = any($1::uuid[]) and repo_id = any($2::uuid[])
          and queued_at between $3 and $4 and status in ('completed', 'partial')`,
      [installationIds, repoIds, from.toISOString(), to.toISOString()],
    )
  ).rows.map((r) => ({ input: Number(r.input), output: Number(r.output) }));

  const sizeClasses: SizeClassUsage[] = CLASSES.map((c) => {
    const inClass = runs.filter((r) => r.input >= c.min && r.input < c.max);
    const medianInputTokens = inClass.length ? median(inClass.map((r) => r.input)) : 0;
    const medianOutputTokens = inClass.length ? median(inClass.map((r) => r.output)) : 0;
    return {
      label: c.label,
      runs: inClass.length,
      medianInputTokens,
      medianOutputTokens,
      estimatedCostUsd: inClass.length
        ? estimateCostUsd(provider, {
            inputTokens: medianInputTokens,
            outputTokens: medianOutputTokens,
          })
        : null,
    };
  });

  const finished = s.reviews.completed + s.reviews.partial + s.reviews.failed;
  process.stdout.write(
    renderPilotReport({
      from,
      to,
      repositories: repoIds.length,
      reviews: s.reviews,
      completion: { ok: s.reviews.completed + s.reviews.partial, finished },
      durationMedianMs: s.duration.median_ms,
      durationSample: s.duration.sample,
      feedback: {
        votes: s.feedback.votes,
        useful: s.feedback.useful,
        falsePositive: s.feedback.false_positive,
        known: s.feedback.known,
      },
      duplicates: {
        runsWithDuplicates: s.duplicates.runs_with_duplicates,
        runsWithComments: s.duplicates.runs_with_comments,
      },
      summary: { withSummary: s.summary.with_summary, eligible: s.summary.eligible },
      findings: s.findings,
      sizeClasses,
    }) + "\n",
  );
} finally {
  await handle.close();
}
