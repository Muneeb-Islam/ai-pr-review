// The endpoint table: one entry per route, shared by the api (registration, validation, OpenAPI) and by the
// typed web client. Handlers live in apps/api; only the contract lives here.
import { z } from "zod";
import {
  analyticsQuerySchema,
  analyticsSummarySchema,
  analyticsTimeseriesSchema,
  exportQuerySchema,
  feedbackBodySchema,
  feedbackResponseSchema,
  explorerFindingSchema,
  historyParamsSchema,
  listAuditQuerySchema,
  listAuditResponseSchema,
  listFindingsQuerySchema,
  listFindingsResponseSchema,
  pullHistoryResponseSchema,
  timeseriesQuerySchema,
} from "./insights";
import {
  cancelResponseSchema,
  credentialResponseSchema,
  deleteCredentialQuerySchema,
  idParamSchema,
  installationSettingsResponseSchema,
  listCredentialsResponseSchema,
  patchPlatformAiBodySchema,
  platformAiResponseSchema,
  listReposQuerySchema,
  listReposResponseSchema,
  listRunsQuerySchema,
  listRunsResponseSchema,
  meResponseSchema,
  okResponseSchema,
  patchInstallationSettingsBodySchema,
  patchRepoSettingsBodySchema,
  putCredentialBodySchema,
  repoSchema,
  repoSettingsResponseSchema,
  rerunResponseSchema,
  runDetailSchema,
  testCredentialResponseSchema,
} from "./schemas";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface EndpointDef {
  method: HttpMethod;
  /** Fastify-style path, `:name` for parameters. */
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** `session` needs a signed-in user; `none` is public. Mutations with a session also need the CSRF header. */
  auth: "none" | "session";
  /**
   * What the `:id` path parameter refers to. The api resolves the caller's access to it before the handler
   * runs: no access (or a different tenant) is 404, too little role is 403. A run is reached through its
   * repository: access to the run is access to the repository it belongs to.
   */
  resource?: "repo" | "installation" | "run" | "finding";
  /** Minimum role the caller needs on the resource (viewer when omitted). */
  role?: "viewer" | "admin";
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Body of the successful response. */
  response: z.ZodType;
  /** Defaults to 200. */
  status?: number;
  /** A long-lived `text/event-stream` response instead of a JSON body (the handler writes it itself). */
  stream?: "sse";
  /** A file download instead of a JSON body (the handler writes it itself). */
  download?: "csv";
  /** Stricter per-user rate limit than the default (requests per minute), for endpoints that call out. */
  rateLimitPerMinute?: number;
}

const defineEndpoint = <const T extends EndpointDef>(def: T): T => def;

const idParams = z.object({ id: idParamSchema });

export const endpoints = {
  // ----- auth (browser navigations, not JSON calls) -----
  login: defineEndpoint({
    method: "GET",
    path: "/auth/github/login",
    summary: "Start the GitHub sign-in",
    description: "Redirects to GitHub. `return_to` must be a path on the dashboard.",
    tag: "auth",
    auth: "none",
    query: z.object({ return_to: z.string().max(500).optional() }),
    response: z.null(),
    status: 302,
  }),
  loginCallback: defineEndpoint({
    method: "GET",
    path: "/auth/github/callback",
    summary: "Finish the GitHub sign-in",
    description:
      "Checks `state`, exchanges the code, creates the session and redirects to the dashboard.",
    tag: "auth",
    auth: "none",
    query: z.object({
      code: z.string().max(2000).optional(),
      state: z.string().max(2000).optional(),
      error: z.string().max(200).optional(),
    }),
    response: z.null(),
    status: 302,
  }),
  logout: defineEndpoint({
    method: "POST",
    path: "/auth/logout",
    summary: "Sign out",
    tag: "auth",
    auth: "session",
    response: okResponseSchema,
  }),

  // ----- identity -----
  me: defineEndpoint({
    method: "GET",
    path: "/api/me",
    summary: "Current user, accessible installations and the App install link",
    tag: "me",
    auth: "session",
    response: meResponseSchema,
  }),

  // ----- repositories -----
  listRepos: defineEndpoint({
    method: "GET",
    path: "/api/repos",
    summary: "Repositories the user can see, with their last run",
    tag: "repositories",
    auth: "session",
    query: listReposQuerySchema,
    response: listReposResponseSchema,
  }),
  getRepo: defineEndpoint({
    method: "GET",
    path: "/api/repos/:id",
    resource: "repo",
    summary: "One repository",
    tag: "repositories",
    auth: "session",
    params: idParams,
    response: repoSchema,
  }),

  // ----- runs -----
  listRuns: defineEndpoint({
    method: "GET",
    path: "/api/runs",
    summary: "Runs of the repositories the user can see, newest first",
    description:
      "Filters: repo_id, status (one or a comma-separated list), branch (base branch), author, severity, from, to. " +
      "Cursor pagination: pass next_cursor back as cursor.",
    tag: "runs",
    auth: "session",
    query: listRunsQuerySchema,
    response: listRunsResponseSchema,
  }),
  getRun: defineEndpoint({
    method: "GET",
    path: "/api/runs/:id",
    resource: "run",
    summary: "One run with its agent runs, findings, skipped files, warnings and usage",
    tag: "runs",
    auth: "session",
    params: idParams,
    response: runDetailSchema,
  }),

  rerunRun: defineEndpoint({
    method: "POST",
    path: "/api/runs/:id/rerun",
    resource: "run",
    summary: "Re-run a review for the pull request's current commit",
    description:
      "Admin only, audited. Creates a new queued run linked to this one (`parent_run_id`) for the commit the " +
      "pull request points at now, and supersedes any run of the pull request that is still active. Answers 409 " +
      "when the pull request is closed or the repository or installation is no longer active.",
    tag: "runs",
    auth: "session",
    role: "admin",
    params: idParams,
    response: rerunResponseSchema,
    status: 202,
    rateLimitPerMinute: 10,
  }),
  cancelRun: defineEndpoint({
    method: "POST",
    path: "/api/runs/:id/cancel",
    resource: "run",
    summary: "Cancel a queued or running review",
    description:
      "Admin only, audited. Stops the run and closes its Check Run. Answers 409 when the run is not queued or running.",
    tag: "runs",
    auth: "session",
    role: "admin",
    params: idParams,
    response: cancelResponseSchema,
  }),

  // ----- findings, feedback and pull request history -----
  listFindings: defineEndpoint({
    method: "GET",
    path: "/api/findings",
    summary: "Findings across runs of the repositories the user can see, newest first",
    description:
      "Filters: repo_id, run_id, severity, category, agent, status (posted, summary_only, suppressed or all; " +
      "default: what the review reported), path (part of the file path), from, to. Cursor pagination.",
    tag: "findings",
    auth: "session",
    query: listFindingsQuerySchema,
    response: listFindingsResponseSchema,
  }),
  getFinding: defineEndpoint({
    method: "GET",
    path: "/api/findings/:id",
    resource: "finding",
    summary: "One finding with its feedback and a link to the GitHub comment or line",
    tag: "findings",
    auth: "session",
    params: idParams,
    response: explorerFindingSchema,
  }),
  giveFeedback: defineEndpoint({
    method: "POST",
    path: "/api/findings/:id/feedback",
    resource: "finding",
    summary: "Say whether a finding was useful, a false positive or already known",
    description:
      "Any user who can see the repository. One vote per user per finding: sending it again replaces the verdict " +
      "and note. Findings the review dropped (suppressed) cannot be rated: 409.",
    tag: "findings",
    auth: "session",
    params: idParams,
    body: feedbackBodySchema,
    response: feedbackResponseSchema,
    rateLimitPerMinute: 60,
  }),
  getPullHistory: defineEndpoint({
    method: "GET",
    path: "/api/repos/:id/pulls/:number/history",
    resource: "repo",
    summary: "Every run of one pull request, with what changed in the findings between them",
    tag: "runs",
    auth: "session",
    params: historyParamsSchema,
    response: pullHistoryResponseSchema,
  }),

  // ----- analytics -----
  getAnalyticsSummary: defineEndpoint({
    method: "GET",
    path: "/api/analytics/summary",
    summary: "The PRD success metrics for the repositories the user can see",
    description:
      "Filters: repo_id or installation_id, from, to (default: the last 30 days). Every rate comes with the " +
      "number of observations it rests on.",
    tag: "analytics",
    auth: "session",
    query: analyticsQuerySchema,
    response: analyticsSummarySchema,
  }),
  getAnalyticsTimeseries: defineEndpoint({
    method: "GET",
    path: "/api/analytics/timeseries",
    summary: "Reviews, findings, duration, failures and tokens over time",
    description:
      "Same filters as the summary plus bucket (day or week). Buckets are UTC; a range longer than 92 days is " +
      "answered in weeks whatever was asked.",
    tag: "analytics",
    auth: "session",
    query: timeseriesQuerySchema,
    response: analyticsTimeseriesSchema,
  }),

  // ----- audit and export -----
  listAuditLog: defineEndpoint({
    method: "GET",
    path: "/api/installations/:id/audit",
    resource: "installation",
    summary: "Settings, credential, re-run and cancel actions of the installation, newest first",
    tag: "audit",
    auth: "session",
    role: "admin",
    params: idParams,
    query: listAuditQuerySchema,
    response: listAuditResponseSchema,
  }),
  exportCsv: defineEndpoint({
    method: "GET",
    path: "/api/repos/:id/export",
    resource: "repo",
    summary: "Download the repository's runs or findings as CSV",
    description:
      "Admin only, audited. kind is runs or findings; from and to bound the time the run was queued. At most " +
      "20,000 rows. Cells that a spreadsheet could read as a formula are prefixed with an apostrophe.",
    tag: "export",
    auth: "session",
    role: "admin",
    params: idParams,
    query: exportQuerySchema,
    response: z.null(),
    download: "csv",
    rateLimitPerMinute: 10,
  }),

  // ----- live updates -----
  events: defineEndpoint({
    method: "GET",
    path: "/api/events",
    summary: "Server-sent events: run.updated for the repositories the user can see",
    description:
      "A `text/event-stream`. `run.updated` events carry run_id, repo_id, status and at (see runUpdatedEventSchema); " +
      "refetch the run through the normal endpoints. Comment lines are heartbeats. The stream ends when the session does.",
    tag: "runs",
    auth: "session",
    stream: "sse",
    response: z.null(),
  }),

  // ----- repository settings -----
  getRepoSettings: defineEndpoint({
    method: "GET",
    path: "/api/repos/:id/settings",
    resource: "repo",
    summary: "Repository settings and the effective configuration",
    tag: "settings",
    auth: "session",
    params: idParams,
    response: repoSettingsResponseSchema,
  }),
  patchRepoSettings: defineEndpoint({
    method: "PATCH",
    path: "/api/repos/:id/settings",
    resource: "repo",
    summary: "Update repository settings, or enable or disable the repository",
    description:
      "Admin only. Unknown keys and invalid values are rejected; `base_url` must be a public HTTPS URL.",
    tag: "settings",
    auth: "session",
    role: "admin",
    params: idParams,
    body: patchRepoSettingsBodySchema,
    response: repoSettingsResponseSchema,
  }),

  // ----- repository credentials -----
  listRepoCredentials: defineEndpoint({
    method: "GET",
    path: "/api/repos/:id/credentials",
    resource: "repo",
    summary: "Which provider keys the repository has (never the keys)",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    response: listCredentialsResponseSchema,
  }),
  putRepoCredential: defineEndpoint({
    method: "PUT",
    path: "/api/repos/:id/credentials",
    resource: "repo",
    summary: "Set or replace a provider key for the repository (write-only)",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    body: putCredentialBodySchema,
    response: credentialResponseSchema,
  }),
  deleteRepoCredential: defineEndpoint({
    method: "DELETE",
    path: "/api/repos/:id/credentials",
    resource: "repo",
    summary: "Remove the repository's key for a provider",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    query: deleteCredentialQuerySchema,
    response: okResponseSchema,
  }),
  testRepoCredential: defineEndpoint({
    method: "POST",
    path: "/api/repos/:id/credentials/test",
    resource: "repo",
    summary: "Check a provider key with one minimal provider call (the key is not stored)",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    body: putCredentialBodySchema,
    response: testCredentialResponseSchema,
    rateLimitPerMinute: 10,
  }),

  // ----- platform-wide AI setting (platform administrators only: `PLATFORM_ADMINS`) -----
  getPlatformAi: defineEndpoint({
    method: "GET",
    path: "/api/platform/ai",
    summary: "The platform-wide AI provider, models and which keys exist (never the keys)",
    tag: "platform",
    auth: "session",
    response: platformAiResponseSchema,
  }),
  patchPlatformAi: defineEndpoint({
    method: "PATCH",
    path: "/api/platform/ai",
    summary: "Choose the active provider and the model of each provider",
    description: "The active provider needs a stored key and a model.",
    tag: "platform",
    auth: "session",
    body: patchPlatformAiBodySchema,
    response: platformAiResponseSchema,
  }),
  putPlatformAiCredential: defineEndpoint({
    method: "PUT",
    path: "/api/platform/ai/credentials",
    summary: "Store or replace the platform-wide key of a provider (write-only)",
    tag: "platform",
    auth: "session",
    body: putCredentialBodySchema,
    response: platformAiResponseSchema,
  }),
  deletePlatformAiCredential: defineEndpoint({
    method: "DELETE",
    path: "/api/platform/ai/credentials",
    summary: "Remove the platform-wide key of a provider",
    tag: "platform",
    auth: "session",
    query: deleteCredentialQuerySchema,
    response: platformAiResponseSchema,
  }),

  // ----- installation settings and credentials -----
  getInstallationSettings: defineEndpoint({
    method: "GET",
    path: "/api/installations/:id/settings",
    resource: "installation",
    summary: "Installation-wide defaults and quotas",
    tag: "settings",
    auth: "session",
    params: idParams,
    response: installationSettingsResponseSchema,
  }),
  patchInstallationSettings: defineEndpoint({
    method: "PATCH",
    path: "/api/installations/:id/settings",
    resource: "installation",
    summary: "Update installation-wide defaults",
    description:
      "Admin only (organization owner, or the owner of a personal account). Quotas are read-only.",
    tag: "settings",
    auth: "session",
    role: "admin",
    params: idParams,
    body: patchInstallationSettingsBodySchema,
    response: installationSettingsResponseSchema,
  }),
  listInstallationCredentials: defineEndpoint({
    method: "GET",
    path: "/api/installations/:id/credentials",
    resource: "installation",
    summary: "Which provider keys the installation has (never the keys)",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    response: listCredentialsResponseSchema,
  }),
  putInstallationCredential: defineEndpoint({
    method: "PUT",
    path: "/api/installations/:id/credentials",
    resource: "installation",
    summary: "Set or replace the installation's default provider key (write-only)",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    body: putCredentialBodySchema,
    response: credentialResponseSchema,
  }),
  deleteInstallationCredential: defineEndpoint({
    method: "DELETE",
    path: "/api/installations/:id/credentials",
    resource: "installation",
    summary: "Remove the installation's key for a provider",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    query: deleteCredentialQuerySchema,
    response: okResponseSchema,
  }),
  testInstallationCredential: defineEndpoint({
    method: "POST",
    path: "/api/installations/:id/credentials/test",
    resource: "installation",
    summary: "Check a provider key with one minimal provider call (the key is not stored)",
    tag: "credentials",
    auth: "session",
    role: "admin",
    params: idParams,
    body: putCredentialBodySchema,
    response: testCredentialResponseSchema,
    rateLimitPerMinute: 10,
  }),
} as const;

export type EndpointName = keyof typeof endpoints;
export type Endpoints = typeof endpoints;

export const isMutation = (method: HttpMethod): boolean => method !== "GET";
