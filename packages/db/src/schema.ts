// Drizzle schema for docs/design.md §5. Import this only inside packages/db (tenant-scoped functions)
// and for migrations; apps use the exported functions, never the raw tables (see eslint.config.mjs).
//
// Conventions
//  - Primary keys are uuids. GitHub ids are bigint columns mapped to JS numbers (safe below 2^53).
//  - Tenant tables carry `installation_id` (design §5). Child rows reference their parent through a
//    composite foreign key that includes `installation_id`, so the database itself refuses a row whose
//    installation differs from its parent's.
//  - Timestamps are timestamptz with millisecond precision so they round-trip through JS Dates
//    exactly (cursor pagination depends on it).
//  - Data minimisation: no column stores diffs or file contents; `findings.evidence` is varchar(500).
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import {
  ACCOUNT_TYPES,
  AGENT_IDS,
  AGENT_RUN_STATUSES,
  CATEGORIES,
  FEEDBACK_VERDICTS,
  INSTALLATION_ROLES,
  INSTALLATION_STATUSES,
  POSTED_COMMENT_KINDS,
  PROVIDERS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  SEVERITIES,
  SUPPRESS_REASONS,
  type TokenUsage,
} from "@ai-pr-review/shared";

/** Maximum length of `findings.evidence` (design §9, data minimisation). */
export const EVIDENCE_MAX_CHARS = 500;

// ---------- enums (values come from packages/shared, the single source of truth) ----------

export const runStatusEnum = pgEnum("run_status", RUN_STATUSES);
export const runTriggerEnum = pgEnum("run_trigger", RUN_TRIGGERS);
export const agentIdEnum = pgEnum("agent_id", AGENT_IDS);
export const agentRunStatusEnum = pgEnum("agent_run_status", AGENT_RUN_STATUSES);
export const severityEnum = pgEnum("severity", SEVERITIES);
export const categoryEnum = pgEnum("category", CATEGORIES);
export const suppressReasonEnum = pgEnum("suppress_reason", SUPPRESS_REASONS);
export const feedbackVerdictEnum = pgEnum("feedback_verdict", FEEDBACK_VERDICTS);
export const installationStatusEnum = pgEnum("installation_status", INSTALLATION_STATUSES);
export const accountTypeEnum = pgEnum("account_type", ACCOUNT_TYPES);
export const installationRoleEnum = pgEnum("installation_role", INSTALLATION_ROLES);
export const postedCommentKindEnum = pgEnum("posted_comment_kind", POSTED_COMMENT_KINDS);
export const providerEnum = pgEnum("provider", PROVIDERS);

// ---------- column helpers ----------

const ts = (name: string) => timestamp(name, { withTimezone: true, precision: 3, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const githubId = (name: string) => bigint(name, { mode: "number" });

/** Opaque bytes (provider key ciphertext; the layout is defined by Phase 4 encryption). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

// ---------- accounts ----------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubUserId: githubId("github_user_id").notNull().unique(),
  login: text("login").notNull(),
  avatarUrl: text("avatar_url"),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    csrfSecret: text("csrf_secret").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("sessions_user_id_idx").on(t.userId),
    index("sessions_expires_at_idx").on(t.expiresAt),
  ],
);

// ---------- tenancy ----------

export const installations = pgTable("installations", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubInstallationId: githubId("github_installation_id").notNull().unique(),
  accountLogin: text("account_login").notNull(),
  accountType: accountTypeEnum("account_type").notNull(),
  status: installationStatusEnum("status").notNull().default("active"),
  createdAt: createdAt(),
});

export const userInstallations = pgTable(
  "user_installations",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    role: installationRoleEnum("role").notNull(),
    refreshedAt: ts("refreshed_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.installationId] }),
    index("user_installations_installation_id_idx").on(t.installationId),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    githubRepoId: githubId("github_repo_id").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").notNull(),
    isPrivate: boolean("is_private").notNull(),
    /** Reviews turned on by an admin (dashboard). */
    enabled: boolean("enabled").notNull().default(true),
    /** Still part of the installation's repository selection on GitHub. */
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("repositories_installation_github_repo_uq").on(t.installationId, t.githubRepoId),
    // Target of the composite foreign keys of child tables.
    unique("repositories_installation_id_id_uq").on(t.installationId, t.id),
    index("repositories_installation_full_name_idx").on(t.installationId, t.fullName),
  ],
);

export const repoSettings = pgTable(
  "repo_settings",
  {
    repoId: uuid("repo_id").primaryKey(),
    installationId: uuid("installation_id").notNull(),
    /** Dashboard layer of the configuration (design §6); validated before it is stored. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "repo_settings_repo_fk",
      columns: [t.installationId, t.repoId],
      foreignColumns: [repositories.installationId, repositories.id],
    }).onDelete("cascade"),
  ],
);

export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    /** Null = installation-wide default; set = override for one repository. */
    repoId: uuid("repo_id"),
    provider: providerEnum("provider").notNull(),
    /** Opaque ciphertext. Only the worker-side system function ever returns it (design §9). */
    ciphertext: bytea("ciphertext").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    last4: varchar("last4", { length: 4 }).notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "provider_credentials_repo_fk",
      columns: [t.installationId, t.repoId],
      foreignColumns: [repositories.installationId, repositories.id],
    }).onDelete("cascade"),
    // One key per provider per scope, so PUT replaces rather than accumulates.
    uniqueIndex("provider_credentials_installation_provider_uq")
      .on(t.installationId, t.provider)
      .where(sql`${t.repoId} is null`),
    uniqueIndex("provider_credentials_repo_provider_uq")
      .on(t.repoId, t.provider)
      .where(sql`${t.repoId} is not null`),
  ],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    /** `X-GitHub-Delivery`. The primary key makes redelivery idempotent (PL-03). */
    deliveryId: text("delivery_id").primaryKey(),
    event: text("event").notNull(),
    /** Null until the delivery is matched to an installation. */
    installationId: uuid("installation_id").references(() => installations.id, {
      onDelete: "set null",
    }),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
    outcome: text("outcome"),
  },
  (t) => [index("webhook_deliveries_received_at_idx").on(t.receivedAt)],
);

// ---------- review runs ----------

export const reviewRuns = pgTable(
  "review_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id").notNull(),
    repoId: uuid("repo_id").notNull(),
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    baseRef: text("base_ref").notNull(),
    trigger: runTriggerEnum("trigger").notNull(),
    triggeredBy: text("triggered_by"),
    status: runStatusEnum("status").notNull().default("queued"),
    statusReason: text("status_reason"),
    checkRunId: githubId("check_run_id"),
    summaryCommentId: githubId("summary_comment_id"),
    queuedAt: ts("queued_at").notNull().defaultNow(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    parentRunId: uuid("parent_run_id").references((): AnyPgColumn => reviewRuns.id, {
      onDelete: "set null",
    }),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    usage: jsonb("usage")
      .$type<TokenUsage>()
      .notNull()
      .default({ inputTokens: 0, outputTokens: 0 }),
  },
  (t) => [
    foreignKey({
      name: "review_runs_repo_fk",
      columns: [t.installationId, t.repoId],
      foreignColumns: [repositories.installationId, repositories.id],
    }).onDelete("cascade"),
    unique("review_runs_installation_id_id_uq").on(t.installationId, t.id),
    index("review_runs_repo_queued_idx").on(t.repoId, t.queuedAt.desc().nullsFirst()),
    index("review_runs_status_idx").on(t.status),
    index("review_runs_repo_pr_head_idx").on(t.repoId, t.prNumber, t.headSha),
    // Tenant-wide listing in the cursor order (queued_at desc, id desc).
    index("review_runs_installation_queued_idx").on(
      t.installationId,
      t.queuedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    // Sweeper and queue views only ever look at active runs; keep that index tiny.
    index("review_runs_active_idx")
      .on(t.installationId, t.queuedAt)
      .where(sql`${t.status} in ('queued', 'running')`),
    // Lifecycle invariants (scope §5.1), enforced even for writers that bypass transitionRun.
    check(
      "review_runs_finished_at_matches_status",
      sql`(${t.status} in ('queued', 'running')) = (${t.finishedAt} is null)`,
    ),
    check(
      "review_runs_running_has_started_at",
      sql`${t.status} <> 'running' or ${t.startedAt} is not null`,
    ),
    check("review_runs_pr_number_positive", sql`${t.prNumber} > 0`),
  ],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id").notNull(),
    runId: uuid("run_id").notNull(),
    agent: agentIdEnum("agent").notNull(),
    status: agentRunStatusEnum("status").notNull(),
    startedAt: ts("started_at"),
    durationMs: integer("duration_ms").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    retries: integer("retries").notNull().default(0),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
  },
  (t) => [
    foreignKey({
      name: "agent_runs_run_fk",
      columns: [t.installationId, t.runId],
      foreignColumns: [reviewRuns.installationId, reviewRuns.id],
    }).onDelete("cascade"),
    index("agent_runs_run_id_idx").on(t.runId),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id").notNull(),
    runId: uuid("run_id").notNull(),
    repoId: uuid("repo_id").notNull(),
    agent: agentIdEnum("agent").notNull(),
    category: categoryEnum("category").notNull(),
    severity: severityEnum("severity").notNull(),
    confidence: real("confidence").notNull(),
    title: text("title").notNull(),
    filePath: text("file_path"),
    startLine: integer("start_line"),
    endLine: integer("end_line"),
    /** Short quoted excerpt only (never a diff or a file). */
    evidence: varchar("evidence", { length: EVIDENCE_MAX_CHARS }).notNull(),
    impact: text("impact").notNull(),
    recommendation: text("recommendation").notNull(),
    suggestedTest: text("suggested_test"),
    /** design §12 fingerprint; equals `Finding.id` in packages/shared. */
    fingerprint: text("fingerprint").notNull(),
    posted: boolean("posted").notNull().default(false),
    suppressedReason: suppressReasonEnum("suppressed_reason"),
  },
  (t) => [
    foreignKey({
      name: "findings_run_fk",
      columns: [t.installationId, t.runId],
      foreignColumns: [reviewRuns.installationId, reviewRuns.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "findings_repo_fk",
      columns: [t.installationId, t.repoId],
      foreignColumns: [repositories.installationId, repositories.id],
    }).onDelete("cascade"),
    unique("findings_installation_id_id_uq").on(t.installationId, t.id),
    index("findings_run_id_idx").on(t.runId),
    index("findings_repo_severity_idx").on(t.repoId, t.severity),
    check("findings_confidence_range", sql`${t.confidence} >= 0 and ${t.confidence} <= 1`),
    check("findings_start_line_positive", sql`${t.startLine} is null or ${t.startLine} > 0`),
    check(
      "findings_end_line_not_before_start",
      sql`${t.endLine} is null or ${t.startLine} is null or ${t.endLine} >= ${t.startLine}`,
    ),
    check("findings_suppressed_not_posted", sql`${t.suppressedReason} is null or not ${t.posted}`),
  ],
);

export const postedComments = pgTable(
  "posted_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id").notNull(),
    runId: uuid("run_id").notNull(),
    kind: postedCommentKindEnum("kind").notNull(),
    githubId: githubId("github_id").notNull(),
    /** Null for the summary comment and the check run. */
    fingerprint: text("fingerprint"),
    headSha: text("head_sha").notNull(),
  },
  (t) => [
    foreignKey({
      name: "posted_comments_run_fk",
      columns: [t.installationId, t.runId],
      foreignColumns: [reviewRuns.installationId, reviewRuns.id],
    }).onDelete("cascade"),
    index("posted_comments_run_id_idx").on(t.runId),
    index("posted_comments_fingerprint_sha_idx").on(t.fingerprint, t.headSha),
  ],
);

export const findingFeedback = pgTable(
  "finding_feedback",
  {
    findingId: uuid("finding_id").notNull(),
    installationId: uuid("installation_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verdict: feedbackVerdictEnum("verdict").notNull(),
    note: varchar("note", { length: 1000 }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.findingId, t.userId] }),
    foreignKey({
      name: "finding_feedback_finding_fk",
      columns: [t.installationId, t.findingId],
      foreignColumns: [findings.installationId, findings.id],
    }).onDelete("cascade"),
    index("finding_feedback_installation_idx").on(t.installationId),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    installationId: uuid("installation_id")
      .notNull()
      .references(() => installations.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target").notNull(),
    /** Must never contain secrets (provider keys, tokens). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_installation_at_idx").on(
      t.installationId,
      t.at.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);
