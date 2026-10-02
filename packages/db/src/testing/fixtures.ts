// Fixtures for tests: build tenants and runs through the real data-access functions.
import type { RunStatus } from "@ai-pr-review/shared";
import type { Database } from "../client";
import {
  createRun,
  insertFindings,
  recordAgentRun,
  recordPostedComment,
  setFeedback,
  transitionRun,
  upsertRepository,
  type NewFinding,
} from "../tenant";
import { upsertInstallationFromGitHub, upsertUser, type User } from "../system";
import type { Installation, Repo, Run } from "../types";

let counter = 0;
const next = () => ++counter;

export interface Tenant {
  label: string;
  installation: Installation;
  repo: Repo;
  repo2: Repo;
  user: User;
}

/** An installation with two repositories and a user. */
export async function createTenant(db: Database, label: string): Promise<Tenant> {
  const n = next();
  const installation = await upsertInstallationFromGitHub(db, {
    githubInstallationId: 10_000_000 + n,
    accountLogin: `${label}-${n}`,
    accountType: "organization",
  });
  const repo = await upsertRepository(db, installation.id, {
    githubRepoId: 20_000_000 + n * 10,
    fullName: `${label}-${n}/api`,
    defaultBranch: "main",
    isPrivate: true,
  });
  const repo2 = await upsertRepository(db, installation.id, {
    githubRepoId: 20_000_000 + n * 10 + 1,
    fullName: `${label}-${n}/web`,
    defaultBranch: "main",
    isPrivate: false,
  });
  const user = await upsertUser(db, { githubUserId: 30_000_000 + n, login: `${label}-user-${n}` });
  return { label, installation, repo, repo2, user };
}

export interface RunOverrides {
  repo?: Repo;
  prNumber?: number;
  headSha?: string;
  at?: Date;
  parentRunId?: string;
}

export async function makeRun(db: Database, tenant: Tenant, o: RunOverrides = {}): Promise<Run> {
  const n = next();
  return createRun(db, tenant.installation.id, {
    repoId: (o.repo ?? tenant.repo).id,
    prNumber: o.prNumber ?? n,
    headSha: o.headSha ?? `sha${n}`.padEnd(40, "0"),
    baseSha: "b".repeat(40),
    baseRef: "main",
    trigger: "pull_request",
    triggeredBy: "octocat",
    ...(o.at ? { at: o.at } : {}),
    ...(o.parentRunId ? { parentRunId: o.parentRunId } : {}),
  });
}

/** Creates a run and walks it (through legal transitions only) to `status`. */
export async function makeRunInStatus(
  db: Database,
  tenant: Tenant,
  status: RunStatus,
  o: RunOverrides = {},
): Promise<Run> {
  const run = await makeRun(db, tenant, o);
  const id = tenant.installation.id;
  switch (status) {
    case "queued":
      return run;
    case "running":
      return transitionRun(db, id, run.id, "running");
    case "superseded":
    case "cancelled":
      return transitionRun(db, id, run.id, status);
    case "skipped":
      await transitionRun(db, id, run.id, "running");
      return transitionRun(db, id, run.id, "skipped", { reason: "too_large" });
    default:
      await transitionRun(db, id, run.id, "running");
      return transitionRun(db, id, run.id, status);
  }
}

export function sampleFinding(overrides: Partial<NewFinding> = {}): NewFinding {
  const n = next();
  return {
    agent: "code_review",
    category: "bug",
    severity: "high",
    confidence: 0.9,
    title: `Finding ${n}`,
    filePath: "src/a.ts",
    startLine: 10,
    endLine: 12,
    evidence: "user.name is read before the null check",
    impact: "Crash on anonymous users",
    recommendation: "Check for null first",
    fingerprint: `fp${n}`.padEnd(16, "0"),
    ...overrides,
  };
}

/** A completed run with an agent run, findings (one suppressed), a posted comment and feedback. */
export async function makeFullRun(db: Database, tenant: Tenant, o: RunOverrides = {}) {
  const id = tenant.installation.id;
  const run = await makeRunInStatus(db, tenant, "running", o);
  const agentRun = await recordAgentRun(db, id, run.id, {
    agent: "code_review",
    status: "ok",
    durationMs: 1200,
    inputTokens: 100,
    outputTokens: 50,
    retries: 0,
    warnings: [],
  });
  const [kept, suppressed] = await insertFindings(db, id, run.id, [
    sampleFinding({ posted: true }),
    sampleFinding({ severity: "low", suppressedReason: "below_threshold" }),
  ]);
  const comment = await recordPostedComment(db, id, run.id, {
    kind: "review_comment",
    githubId: 555_000 + next(),
    fingerprint: kept!.fingerprint,
    headSha: run.headSha,
  });
  const feedback = await setFeedback(db, id, {
    findingId: kept!.id,
    userId: tenant.user.id,
    verdict: "useful",
  });
  const done = await transitionRun(db, id, run.id, "completed");
  return { run: done, agentRun, finding: kept!, suppressed: suppressed!, comment, feedback };
}
