// Analytics (UI-07): the PRD success metrics over the repositories the user can reach. The database does the
// counting (packages/db `analytics.ts`, with what each number means); this turns counts into rates, prices the
// tokens and fills the empty buckets of the charts.
import {
  analyticsSummary,
  analyticsTimeseries,
  getInstallationSettings,
  getRepoSettings,
  type Repo,
} from "@ai-pr-review/db";
import { resolveEffectiveSettings, type AnalyticsSummaryDto } from "@ai-pr-review/shared";
import { estimateCostUsd } from "../analytics/pricing";
import { chooseBucket, fillBuckets, MAX_RANGE_DAYS } from "../analytics/buckets";
import { validationError } from "../http/errors";
import type { Handlers, Platform } from "../http/platform";
import type { AuthContext } from "../auth/sessions";
import { accessibleRepos } from "./runs";

type AnalyticsHandlers = Pick<Handlers, "getAnalyticsSummary" | "getAnalyticsTimeseries">;

const DAY_MS = 86_400_000;
const DEFAULT_RANGE_DAYS = 30;

const rate = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

interface Resolved {
  repos: Repo[];
  installationIds: string[];
  from: Date;
  to: Date;
}

/** The repositories and time range a request asks about, limited to what the user may reach. */
async function resolveScope(
  platform: Platform,
  auth: AuthContext,
  query: {
    repo_id?: string | undefined;
    installation_id?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  },
): Promise<Resolved> {
  const now = platform.now?.() ?? new Date();
  const to = query.to ? new Date(query.to) : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_RANGE_DAYS * DAY_MS);
  if (from.getTime() > to.getTime()) throw validationError(["from: must not be after to"]);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw validationError([`from: the range is longer than ${MAX_RANGE_DAYS} days`]);
  }

  const all = await accessibleRepos(platform, auth, {
    ...(query.installation_id ? { installationId: query.installation_id } : {}),
  });
  // A repository the user cannot reach is "not found" for any other endpoint; here it just covers nothing.
  const repos = [...all.values()].filter((r) => !query.repo_id || r.id === query.repo_id);
  const installationIds = [...new Set(repos.map((r) => r.installationId))];
  return { repos, installationIds, from, to };
}

/** The provider each repository reviews with now (dashboard settings; the repo file cannot set it). */
async function providerOf(platform: Platform, repo: Repo) {
  const ids = [repo.installationId];
  const [installation, settings] = await Promise.all([
    getInstallationSettings(platform.db, ids, repo.installationId),
    getRepoSettings(platform.db, ids, repo.id),
  ]);
  try {
    return resolveEffectiveSettings(installation?.config ?? {}, settings?.config ?? {}).provider;
  } catch {
    return null;
  }
}

export const analyticsHandlers: AnalyticsHandlers = {
  async getAnalyticsSummary({ platform, auth, query }) {
    const { repos, installationIds, from, to } = await resolveScope(platform, auth, query);
    const scope = { repoIds: repos.map((r) => r.id), from, to };
    const s = await analyticsSummary(platform.db, installationIds, scope);

    const finished = s.reviews.completed + s.reviews.partial + s.reviews.failed;
    const votes = s.feedback.votes;

    // Price each repository's tokens with the provider it uses now; tokens of a repository with none are
    // reported as unpriced rather than guessed at.
    const byId = new Map(repos.map((r) => [r.id, r]));
    let inputTokens = 0;
    let outputTokens = 0;
    let pricedTokens = 0;
    let unpricedTokens = 0;
    let cost = 0;
    for (const row of s.usage) {
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      const tokens = row.inputTokens + row.outputTokens;
      const repo = byId.get(row.repoId);
      const provider = repo ? await providerOf(platform, repo) : null;
      if (provider) {
        cost += estimateCostUsd(provider, row);
        pricedTokens += tokens;
      } else {
        unpricedTokens += tokens;
      }
    }

    const body: AnalyticsSummaryDto = {
      range: { from: from.toISOString(), to: to.toISOString() },
      repositories: repos.length,
      reviews: s.reviews,
      completion: {
        rate: rate(s.reviews.completed + s.reviews.partial, finished),
        sample: finished,
      },
      duration: s.duration,
      findings: s.findings,
      feedback: {
        ...s.feedback,
        actionable_rate: rate(s.feedback.useful, votes),
        false_positive_rate: rate(s.feedback.false_positive, votes),
      },
      duplicates: {
        ...s.duplicates,
        rate: rate(s.duplicates.runs_with_duplicates, s.duplicates.runs_with_comments),
      },
      summary_coverage: {
        with_summary: s.summary.with_summary,
        eligible: s.summary.eligible,
        rate: rate(s.summary.with_summary, s.summary.eligible),
      },
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        estimated_cost_usd:
          pricedTokens === 0 && unpricedTokens > 0 ? null : Math.round(cost * 10_000) / 10_000,
        unpriced_tokens: unpricedTokens,
      },
    };
    return body;
  },

  async getAnalyticsTimeseries({ platform, auth, query }) {
    const { repos, installationIds, from, to } = await resolveScope(platform, auth, query);
    const bucket = chooseBucket(from, to, query.bucket);
    const points = await analyticsTimeseries(
      platform.db,
      installationIds,
      { repoIds: repos.map((r) => r.id), from, to },
      bucket,
    );
    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      bucket,
      points: fillBuckets(points, from, to, bucket),
    };
  },
};
