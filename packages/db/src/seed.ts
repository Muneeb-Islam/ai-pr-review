// Demo data for dashboard development (`npm run db:seed`). Built only through the real data-access
// functions, so it also exercises the lifecycle rules. Everything here is fake: the "credential" is a
// placeholder string, not a key, and no real repositories are referenced.
import { eq } from "drizzle-orm";
import type { AgentId, RunStatus } from "@ai-pr-review/shared";
import type { Database } from "./client";
import { installations } from "./schema";
import {
  appendAuditLog,
  createRun,
  insertFindings,
  listFindings,
  putProviderCredential,
  recordAgentRun,
  recordPostedComment,
  setFeedback,
  transitionRun,
  upsertRepoSettings,
  upsertRepository,
  type NewFinding,
} from "./tenant";
import { replaceUserInstallations, upsertInstallationFromGitHub, upsertUser } from "./system";
import type { Repo, Run } from "./types";

export const DEMO_GITHUB_INSTALLATION_ID = 9_000_001;
export const DEMO_GITHUB_USER_ID = 9_100_001;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface SeedSummary {
  installationId: string;
  userId: string;
  repositories: number;
  runs: number;
  findings: number;
}

/**
 * Loads the demo installation. Safe to run repeatedly: an existing demo installation (and, through
 * cascades, everything under it) is replaced.
 */
export async function seedDemoData(db: Database, now: Date = new Date()): Promise<SeedSummary> {
  await db
    .delete(installations)
    .where(eq(installations.githubInstallationId, DEMO_GITHUB_INSTALLATION_ID));

  const installation = await upsertInstallationFromGitHub(db, {
    githubInstallationId: DEMO_GITHUB_INSTALLATION_ID,
    accountLogin: "demo-org",
    accountType: "organization",
  });
  const instId = installation.id;
  const user = await upsertUser(db, {
    githubUserId: DEMO_GITHUB_USER_ID,
    login: "demo-dev",
    avatarUrl: "https://avatars.githubusercontent.com/u/9100001",
  });
  await replaceUserInstallations(db, user.id, [{ installationId: instId, role: "admin" }], now);

  const api = await upsertRepository(db, instId, {
    githubRepoId: 9_200_001,
    fullName: "demo-org/api",
    defaultBranch: "main",
    isPrivate: true,
  });
  const web = await upsertRepository(db, instId, {
    githubRepoId: 9_200_002,
    fullName: "demo-org/web",
    defaultBranch: "main",
    isPrivate: false,
  });
  const docs = await upsertRepository(db, instId, {
    githubRepoId: 9_200_003,
    fullName: "demo-org/docs",
    defaultBranch: "master",
    isPrivate: false,
  });

  await upsertRepoSettings(
    db,
    instId,
    api.id,
    {
      provider: "deepseek",
      model: "example-model",
      review: { mode: "warn", minimum_severity: "high" },
      agents: { final_review: true },
    },
    user.id,
  );
  await upsertRepoSettings(db, instId, web.id, { fork_prs: "review" }, user.id);
  await putProviderCredential(db, instId, {
    provider: "deepseek",
    ciphertext: Buffer.from("seed-placeholder-not-encrypted"),
    keyVersion: 1,
    last4: "0000",
    createdBy: user.id,
  });

  let runs = 0;
  let findingCount = 0;

  /** Creates a run queued at `queuedAt` and walks it to `status` with plausible timings. */
  async function run(
    repo: Repo,
    prNumber: number,
    status: RunStatus,
    queuedAt: Date,
    opts: {
      headSha?: string;
      parentRunId?: string;
      trigger?: Run["trigger"];
      findings?: NewFinding[];
      agents?: Array<{ agent: AgentId; status: "ok" | "failed" | "timeout" | "invalid_output" }>;
      reason?: string;
    } = {},
  ): Promise<Run> {
    runs += 1;
    const base = {
      repoId: repo.id,
      prNumber,
      headSha:
        opts.headSha ??
        `${prNumber.toString(16).padStart(4, "0")}${runs.toString(16).padStart(36, "a")}`,
      baseSha: "b".repeat(40),
      baseRef: repo.defaultBranch,
      trigger: opts.trigger ?? ("pull_request" as const),
      triggeredBy: "octocat",
      ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
      at: queuedAt,
    };
    if (status === "skipped") {
      return createRun(db, instId, {
        ...base,
        skip: { reason: opts.reason ?? "draft_pull_request" },
      });
    }
    const created = await createRun(db, instId, base);
    if (status === "queued") return created;
    if (status === "superseded" || status === "cancelled") {
      return transitionRun(db, instId, created.id, status, {
        reason: status === "superseded" ? "new_head_sha" : "cancelled_by_user",
        at: new Date(queuedAt.getTime() + 20_000),
      });
    }
    const startedAt = new Date(queuedAt.getTime() + 8_000);
    const started = await transitionRun(db, instId, created.id, "running", { at: startedAt });
    if (status === "running") return started;

    let agentStart = startedAt.getTime() + 2_000;
    for (const a of opts.agents ?? [{ agent: "code_review", status: "ok" }]) {
      const duration = 25_000 + Math.floor((agentStart % 7) * 4_000);
      await recordAgentRun(db, instId, created.id, {
        agent: a.agent,
        status: a.status,
        startedAt: new Date(agentStart),
        durationMs: duration,
        inputTokens: 8_000 + (agentStart % 5_000),
        outputTokens: 900 + (agentStart % 700),
        retries: a.status === "ok" ? 0 : 1,
        warnings: a.status === "ok" ? [] : [`${a.agent} ${a.status}`],
      });
      agentStart += duration;
    }
    const stored = await insertFindings(db, instId, created.id, opts.findings ?? []);
    findingCount += stored.length;
    for (const f of stored.filter((s) => s.posted)) {
      await recordPostedComment(db, instId, created.id, {
        kind: "review_comment",
        githubId: 7_000_000 + runs * 100 + (f.startLine ?? 0),
        fingerprint: f.fingerprint,
        headSha: created.headSha,
      });
    }
    if (status === "completed" || status === "partial") {
      await recordPostedComment(db, instId, created.id, {
        kind: "summary",
        githubId: 8_000_000 + runs,
        headSha: created.headSha,
      });
    }
    return transitionRun(db, instId, created.id, status, {
      at: new Date(agentStart + 3_000),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(status === "partial" ? { warnings: ["test_coverage agent timed out"] } : {}),
      usage: { inputTokens: 8_000 + (agentStart % 5_000), outputTokens: 900 + (agentStart % 700) },
    });
  }

  const finding = (n: number, o: Partial<NewFinding> = {}): NewFinding => ({
    agent: "code_review",
    category: "bug",
    severity: "high",
    confidence: 0.9,
    title: `Demo finding ${n}`,
    filePath: `src/module${n % 4}.ts`,
    startLine: 10 + n,
    endLine: 12 + n,
    evidence: "value.name is read before the null check",
    impact: "Throws a TypeError for anonymous users.",
    recommendation: "Check for null before reading the property.",
    fingerprint: `demo${n.toString(16).padStart(12, "0")}`,
    ...o,
  });

  // --- demo-org/api: one run in every lifecycle state ---------------------------------------------
  const t = (msAgo: number) => new Date(now.getTime() - msAgo);
  await run(api, 100, "superseded", t(2 * DAY + 3 * HOUR), { headSha: "1".repeat(40) });
  const reviewed = await run(api, 100, "completed", t(2 * DAY), {
    headSha: "2".repeat(40),
    agents: [
      { agent: "code_review", status: "ok" },
      { agent: "security", status: "ok" },
      { agent: "test_coverage", status: "ok" },
    ],
    findings: [
      finding(1, { posted: true }),
      finding(2, {
        agent: "security",
        category: "security",
        severity: "critical",
        confidence: 0.95,
        title: "SQL built from request input",
        posted: true,
      }),
      finding(3, {
        agent: "test_coverage",
        category: "test_gap",
        severity: "medium",
        posted: true,
      }),
      finding(4, { severity: "low", confidence: 0.5, suppressedReason: "below_threshold" }),
      finding(5, { severity: "info", suppressedReason: "style_only" }),
    ],
  });
  await run(api, 100, "completed", t(2 * DAY - 2 * HOUR), {
    headSha: "2".repeat(40),
    trigger: "dashboard_rerun",
    parentRunId: reviewed.id,
    findings: [finding(1, { posted: true })],
  });
  await run(api, 101, "partial", t(1 * DAY), {
    agents: [
      { agent: "code_review", status: "ok" },
      { agent: "test_coverage", status: "timeout" },
    ],
    findings: [finding(6, { category: "performance", severity: "medium", posted: true })],
  });
  await run(api, 102, "failed", t(20 * HOUR), {
    reason: "missing_provider_credential",
    agents: [{ agent: "code_review", status: "failed" }],
  });
  await run(api, 103, "skipped", t(10 * HOUR), { reason: "draft_pull_request" });
  await run(api, 104, "skipped", t(9 * HOUR), { reason: "fork_pull_request" });
  await run(api, 105, "cancelled", t(8 * HOUR));
  await run(api, 106, "running", t(5 * MINUTE));
  await run(api, 107, "queued", t(1 * MINUTE));

  // --- demo-org/web: a longer history to exercise pagination, filters and analytics ---------------
  for (let i = 0; i < 24; i += 1) {
    const status: RunStatus = i % 9 === 4 ? "partial" : i % 11 === 7 ? "failed" : "completed";
    await run(web, 200 + i, status, t(Math.floor((i + 1) * 2.4 * DAY) + (i % 5) * HOUR), {
      findings:
        status === "failed"
          ? []
          : [finding(10 + i, { severity: i % 3 === 0 ? "high" : "medium", posted: true })],
      agents:
        status === "failed"
          ? [{ agent: "code_review", status: "failed" }]
          : status === "partial"
            ? [
                { agent: "code_review", status: "ok" },
                { agent: "security", status: "invalid_output" },
              ]
            : [{ agent: "code_review", status: "ok" }],
    });
  }
  await run(docs, 300, "skipped", t(3 * DAY), { reason: "target_branch_not_allowed" });

  // Feedback and an audit trail for the dashboard.
  const { items } = await listFindings(db, [instId], { runId: reviewed.id });
  if (items[0])
    await setFeedback(db, instId, { findingId: items[0].id, userId: user.id, verdict: "useful" });
  if (items[1]) {
    await setFeedback(db, instId, {
      findingId: items[1].id,
      userId: user.id,
      verdict: "false_positive",
      note: "Input is validated upstream.",
    });
  }
  await appendAuditLog(db, instId, {
    userId: user.id,
    action: "settings.update",
    target: `repo:${api.id}`,
    metadata: { keys: ["review", "agents"] },
    at: t(3 * DAY),
  });
  await appendAuditLog(db, instId, {
    userId: user.id,
    action: "run.rerun",
    target: `run:${reviewed.id}`,
    at: t(2 * DAY - HOUR),
  });

  return { installationId: instId, userId: user.id, repositories: 3, runs, findings: findingCount };
}
