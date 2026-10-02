// Tenant isolation (design §9, AC-17): data created for installation A is never returned by, or changed
// through, any function scoped to installation B. Every function exported by the tenant layer needs a
// case here; the last test fails if one is missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IllegalTransitionError, InvalidInputError, NotFoundError } from "./errors";
import * as tenantApi from "./tenant";
import {
  appendAuditLog,
  countSuppressedFindings,
  createRun,
  createRunSupersedingOlder,
  deleteProviderCredential,
  findPostedCommentByFingerprint,
  getFinding,
  getInstallation,
  getLatestRunPerRepo,
  getRepoSettings,
  getRepository,
  getRepositoryByGitHubId,
  getRun,
  getRunByCheckRunId,
  insertFindings,
  listAgentRuns,
  listAuditLog,
  listFeedback,
  listFindings,
  listFindingsForRun,
  listInstallations,
  listPostedComments,
  listProviderCredentials,
  listRepositories,
  listRuns,
  listRunsForPullRequest,
  markFindingsPosted,
  putProviderCredential,
  recordAgentRun,
  recordPostedComment,
  setAllRepositoriesActive,
  setFeedback,
  setRepositoriesActive,
  setRepositoryEnabled,
  transitionRun,
  updateRunDetails,
  upsertRepoSettings,
  upsertRepository,
} from "./tenant";
import { createTenant, makeFullRun, makeRun, sampleFinding, type Tenant } from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";
import type { CredentialInfo, Run } from "./types";

type Full = Awaited<ReturnType<typeof makeFullRun>>;
interface Bundle {
  tenant: Tenant;
  full: Full;
  queuedRun: Run;
  unpostedFindingId: string;
  checkRunId: number;
  credential: CredentialInfo;
  repoCredential: CredentialInfo;
  auditId: string;
}

let checkRunCounter = 0;
let t: TestDatabase;
let A: Bundle;
let B: Bundle;

async function bundle(label: string): Promise<Bundle> {
  const tenant = await createTenant(t.db, label);
  const id = tenant.installation.id;
  const full = await makeFullRun(t.db, tenant);
  const queuedRun = await makeRun(t.db, tenant, { repo: tenant.repo, prNumber: full.run.prNumber });
  const checkRunId = 9_000_000 + ++checkRunCounter;
  await updateRunDetails(t.db, id, queuedRun.id, { checkRunId });
  const [unposted] = await insertFindings(t.db, id, queuedRun.id, [sampleFinding()]);
  await upsertRepoSettings(t.db, id, tenant.repo.id, { fork_prs: "review" }, tenant.user.id);
  const credential = await putProviderCredential(t.db, id, {
    provider: "deepseek",
    ciphertext: Buffer.from(`ciphertext-${label}`),
    keyVersion: 1,
    last4: "wxyz",
  });
  const repoCredential = await putProviderCredential(t.db, id, {
    repoId: tenant.repo.id,
    provider: "openai",
    ciphertext: Buffer.from(`ciphertext-repo-${label}`),
    keyVersion: 1,
    last4: "1234",
  });
  const audit = await appendAuditLog(t.db, id, { action: "settings.update", target: "x" });
  return {
    tenant,
    full,
    queuedRun,
    unpostedFindingId: unposted!.id,
    checkRunId,
    credential,
    repoCredential,
    auditId: audit.id,
  };
}

beforeAll(async () => {
  t = await createTestDatabase();
  A = await bundle("alpha");
  B = await bundle("beta");
}, 60_000);
afterAll(async () => {
  await t.drop();
});

const inst = (b: Bundle) => b.tenant.installation.id;
const idsOf = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

/**
 * Each read case: `viewer` queries with only its own installation in scope and must see none of
 * `owner`'s rows (while the owner, with the same query, does see them: the control that keeps the
 * assertion from passing vacuously).
 */
type ReadCase = (viewer: Bundle, owner: Bundle) => Promise<void>;
const readCases: Record<string, ReadCase> = {
  async listInstallations(v, o) {
    expect(idsOf(await listInstallations(t.db, [inst(v)]))).toEqual([inst(v)]);
    expect(idsOf(await listInstallations(t.db, [inst(o)]))).toEqual([inst(o)]);
    expect(await listInstallations(t.db, [])).toEqual([]);
  },
  async getInstallation(v, o) {
    expect(await getInstallation(t.db, [inst(v)], inst(o))).toBeUndefined();
    expect(await getInstallation(t.db, [inst(o)], inst(o))).toBeDefined();
  },
  async listRepositories(v, o) {
    const mine = await listRepositories(t.db, [inst(v)]);
    expect(mine).toHaveLength(2);
    expect(mine.every((r) => r.installationId === inst(v))).toBe(true);
    expect(await listRepositories(t.db, [inst(v)], { installationId: inst(o) })).toEqual([]);
    expect(await listRepositories(t.db, [inst(v)], { search: o.tenant.repo.fullName })).toEqual([]);
    expect(
      await listRepositories(t.db, [inst(o)], { search: o.tenant.repo.fullName }),
    ).toHaveLength(1);
  },
  async getRepository(v, o) {
    expect(await getRepository(t.db, [inst(v)], o.tenant.repo.id)).toBeUndefined();
    expect(await getRepository(t.db, [inst(o)], o.tenant.repo.id)).toBeDefined();
  },
  async getRepositoryByGitHubId(v, o) {
    const id = o.tenant.repo.githubRepoId;
    expect(await getRepositoryByGitHubId(t.db, [inst(v)], id)).toBeUndefined();
    expect(await getRepositoryByGitHubId(t.db, [inst(o)], id)).toBeDefined();
  },
  async getRunByCheckRunId(v, o) {
    expect(await getRunByCheckRunId(t.db, [inst(v)], o.checkRunId)).toBeUndefined();
    expect((await getRunByCheckRunId(t.db, [inst(o)], o.checkRunId))?.id).toBe(o.queuedRun.id);
  },
  async getRepoSettings(v, o) {
    expect(await getRepoSettings(t.db, [inst(v)], o.tenant.repo.id)).toBeUndefined();
    expect(await getRepoSettings(t.db, [inst(o)], o.tenant.repo.id)).toBeDefined();
  },
  async getRun(v, o) {
    expect(await getRun(t.db, [inst(v)], o.full.run.id)).toBeUndefined();
    expect(await getRun(t.db, [inst(o)], o.full.run.id)).toBeDefined();
  },
  async listRuns(v, o) {
    const mine = await listRuns(t.db, [inst(v)]);
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((r) => r.installationId === inst(v))).toBe(true);
    const filtered = { repoId: o.tenant.repo.id };
    expect((await listRuns(t.db, [inst(v)], filtered)).items).toEqual([]);
    expect((await listRuns(t.db, [inst(o)], filtered)).items.length).toBeGreaterThan(0);
    expect(
      (await listRuns(t.db, [inst(v)], { severity: "high" })).items.map((r) => r.id),
    ).not.toContain(o.full.run.id);
    expect((await listRuns(t.db, [])).items).toEqual([]);
  },
  async listRunsForPullRequest(v, o) {
    const pr = o.full.run.prNumber;
    expect(await listRunsForPullRequest(t.db, [inst(v)], o.tenant.repo.id, pr)).toEqual([]);
    expect((await listRunsForPullRequest(t.db, [inst(o)], o.tenant.repo.id, pr)).length).toBe(2);
  },
  async getLatestRunPerRepo(v, o) {
    const mine = await getLatestRunPerRepo(t.db, [inst(v)]);
    expect(mine.every((r) => r.installationId === inst(v))).toBe(true);
    expect(await getLatestRunPerRepo(t.db, [inst(v)], [o.tenant.repo.id])).toEqual([]);
    expect(await getLatestRunPerRepo(t.db, [inst(o)], [o.tenant.repo.id])).toHaveLength(1);
  },
  async listAgentRuns(v, o) {
    expect(await listAgentRuns(t.db, [inst(v)], o.full.run.id)).toEqual([]);
    expect(await listAgentRuns(t.db, [inst(o)], o.full.run.id)).toHaveLength(1);
  },
  async getFinding(v, o) {
    expect(await getFinding(t.db, [inst(v)], o.full.finding.id)).toBeUndefined();
    expect(await getFinding(t.db, [inst(o)], o.full.finding.id)).toBeDefined();
  },
  async listFindingsForRun(v, o) {
    const opts = { includeSuppressed: true };
    expect(await listFindingsForRun(t.db, [inst(v)], o.full.run.id, opts)).toEqual([]);
    expect(await listFindingsForRun(t.db, [inst(o)], o.full.run.id, opts)).toHaveLength(2);
  },
  async listFindings(v, o) {
    const mine = await listFindings(t.db, [inst(v)], { includeSuppressed: true });
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((f) => f.installationId === inst(v))).toBe(true);
    for (const filters of [{ repoId: o.tenant.repo.id }, { runId: o.full.run.id }]) {
      expect((await listFindings(t.db, [inst(v)], filters)).items).toEqual([]);
      expect((await listFindings(t.db, [inst(o)], filters)).items.length).toBeGreaterThan(0);
    }
  },
  async countSuppressedFindings(v, o) {
    expect(await countSuppressedFindings(t.db, [inst(v)], o.full.run.id)).toEqual({});
    expect(await countSuppressedFindings(t.db, [inst(o)], o.full.run.id)).toEqual({
      below_threshold: 1,
    });
  },
  async listPostedComments(v, o) {
    expect(await listPostedComments(t.db, [inst(v)], o.full.run.id)).toEqual([]);
    expect(await listPostedComments(t.db, [inst(o)], o.full.run.id)).toHaveLength(1);
  },
  async findPostedCommentByFingerprint(v, o) {
    const { fingerprint, headSha } = o.full.comment;
    const args = [o.tenant.repo.id, fingerprint!, headSha] as const;
    expect(await findPostedCommentByFingerprint(t.db, [inst(v)], ...args)).toBeUndefined();
    expect(await findPostedCommentByFingerprint(t.db, [inst(o)], ...args)).toBeDefined();
  },
  async listFeedback(v, o) {
    expect(await listFeedback(t.db, [inst(v)], o.full.finding.id)).toEqual([]);
    expect(await listFeedback(t.db, [inst(o)], o.full.finding.id)).toHaveLength(1);
  },
  async listProviderCredentials(v, o) {
    const mine = await listProviderCredentials(t.db, [inst(v)]);
    expect(mine).toHaveLength(2);
    expect(mine.every((c) => c.installationId === inst(v))).toBe(true);
    expect(await listProviderCredentials(t.db, [inst(v)], { installationId: inst(o) })).toEqual([]);
    expect(await listProviderCredentials(t.db, [inst(v)], { repoId: o.tenant.repo.id })).toEqual(
      [],
    );
    expect(
      await listProviderCredentials(t.db, [inst(o)], { repoId: o.tenant.repo.id }),
    ).toHaveLength(1);
  },
  async listAuditLog(v, o) {
    const mine = await listAuditLog(t.db, [inst(v)]);
    expect(mine.items.length).toBeGreaterThan(0);
    expect(mine.items.every((e) => e.installationId === inst(v))).toBe(true);
    expect((await listAuditLog(t.db, [inst(v)], { installationId: inst(o) })).items).toEqual([]);
  },
};

/**
 * Each write case: `actor` (acting on its own installation) tries to change `victim`'s data. It must be
 * refused (NotFoundError, or a no-op result) and the victim's data must be unchanged afterwards.
 */
type WriteCase = (actor: Bundle, victim: Bundle) => Promise<void>;
const rejects = (p: Promise<unknown>) => expect(p).rejects.toBeInstanceOf(NotFoundError);
const writeCases: Record<string, WriteCase> = {
  async upsertRepository(a, v) {
    // Same GitHub repo id under another installation is a different repository, never the victim's row.
    const created = await upsertRepository(t.db, inst(a), {
      githubRepoId: v.tenant.repo.githubRepoId,
      fullName: "attacker/renamed",
      defaultBranch: "evil",
      isPrivate: false,
    });
    expect(created.id).not.toBe(v.tenant.repo.id);
    expect(created.installationId).toBe(inst(a));
    const victimRepo = await getRepository(t.db, [inst(v)], v.tenant.repo.id);
    expect(victimRepo).toEqual(v.tenant.repo);
    // Undo so later assertions about the actor's repository count hold.
    await t.pool.query("delete from repositories where id = $1", [created.id]);
  },
  async setRepositoriesActive(a, v) {
    expect(await setRepositoriesActive(t.db, inst(a), [v.tenant.repo.githubRepoId], false)).toBe(0);
    expect((await getRepository(t.db, [inst(v)], v.tenant.repo.id))?.active).toBe(true);
  },
  async setAllRepositoriesActive(a, v) {
    // The actor deactivates everything it owns; the victim's repositories are untouched.
    expect(await setAllRepositoriesActive(t.db, inst(a), false)).toBe(2);
    expect((await listRepositories(t.db, [inst(v)])).every((r) => r.active)).toBe(true);
    await setAllRepositoriesActive(t.db, inst(a), true);
  },
  async createRunSupersedingOlder(a, v) {
    const input = {
      repoId: v.tenant.repo.id,
      prNumber: v.queuedRun.prNumber,
      headSha: "c".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      trigger: "pull_request" as const,
    };
    await rejects(createRunSupersedingOlder(t.db, inst(a), input));
    // The victim's queued run is not superseded by the refused call.
    expect((await getRun(t.db, [inst(v)], v.queuedRun.id))?.status).toBe("queued");
  },
  async setRepositoryEnabled(a, v) {
    expect(await setRepositoryEnabled(t.db, inst(a), v.tenant.repo.id, false)).toBeUndefined();
    expect((await getRepository(t.db, [inst(v)], v.tenant.repo.id))?.enabled).toBe(true);
  },
  async upsertRepoSettings(a, v) {
    await rejects(upsertRepoSettings(t.db, inst(a), v.tenant.repo.id, { fork_prs: "skip" }));
    expect((await getRepoSettings(t.db, [inst(v)], v.tenant.repo.id))?.config).toEqual({
      fork_prs: "review",
    });
  },
  async createRun(a, v) {
    const input = {
      repoId: v.tenant.repo.id,
      prNumber: 1,
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      baseRef: "main",
      trigger: "pull_request" as const,
    };
    await rejects(createRun(t.db, inst(a), input));
    // Attaching to a foreign parent run is refused too.
    await rejects(
      createRun(t.db, inst(a), { ...input, repoId: a.tenant.repo.id, parentRunId: v.full.run.id }),
    );
    expect((await listRuns(t.db, [inst(v)], { repoId: v.tenant.repo.id })).items).toHaveLength(2);
  },
  async transitionRun(a, v) {
    await rejects(transitionRun(t.db, inst(a), v.queuedRun.id, "cancelled"));
    expect((await getRun(t.db, [inst(v)], v.queuedRun.id))?.status).toBe("queued");
    // A foreign finished run reports "not found", not "illegal transition": no information leaks.
    await expect(transitionRun(t.db, inst(a), v.full.run.id, "running")).rejects.not.toBeInstanceOf(
      IllegalTransitionError,
    );
  },
  async updateRunDetails(a, v) {
    await rejects(updateRunDetails(t.db, inst(a), v.queuedRun.id, { checkRunId: 1 }));
    expect((await getRun(t.db, [inst(v)], v.queuedRun.id))?.checkRunId).toBe(v.checkRunId);
  },
  async recordAgentRun(a, v) {
    await rejects(
      recordAgentRun(t.db, inst(a), v.full.run.id, {
        agent: "security",
        status: "ok",
        durationMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        retries: 0,
        warnings: [],
      }),
    );
    expect(await listAgentRuns(t.db, [inst(v)], v.full.run.id)).toHaveLength(1);
  },
  async insertFindings(a, v) {
    await rejects(insertFindings(t.db, inst(a), v.full.run.id, [sampleFinding()]));
    expect(
      await listFindingsForRun(t.db, [inst(v)], v.full.run.id, { includeSuppressed: true }),
    ).toHaveLength(2);
  },
  async markFindingsPosted(a, v) {
    expect(await markFindingsPosted(t.db, inst(a), [v.unpostedFindingId])).toBe(0);
    expect((await getFinding(t.db, [inst(v)], v.unpostedFindingId))?.posted).toBe(false);
  },
  async recordPostedComment(a, v) {
    await rejects(
      recordPostedComment(t.db, inst(a), v.full.run.id, {
        kind: "summary",
        githubId: 1,
        headSha: v.full.run.headSha,
      }),
    );
    expect(await listPostedComments(t.db, [inst(v)], v.full.run.id)).toHaveLength(1);
  },
  async setFeedback(a, v) {
    await rejects(
      setFeedback(t.db, inst(a), {
        findingId: v.full.finding.id,
        userId: a.tenant.user.id,
        verdict: "false_positive",
      }),
    );
    expect(await listFeedback(t.db, [inst(v)], v.full.finding.id)).toHaveLength(1);
  },
  async putProviderCredential(a, v) {
    await rejects(
      putProviderCredential(t.db, inst(a), {
        repoId: v.tenant.repo.id,
        provider: "anthropic",
        ciphertext: Buffer.from("x"),
        keyVersion: 1,
        last4: "evil",
      }),
    );
    expect(await listProviderCredentials(t.db, [inst(v)])).toHaveLength(2);
  },
  async deleteProviderCredential(a, v) {
    expect(await deleteProviderCredential(t.db, inst(a), v.credential.id)).toBe(false);
    expect(await deleteProviderCredential(t.db, inst(a), v.repoCredential.id)).toBe(false);
    expect(await listProviderCredentials(t.db, [inst(v)])).toHaveLength(2);
  },
  async appendAuditLog(a, v) {
    const before = (await listAuditLog(t.db, [inst(v)])).items.length;
    const entry = await appendAuditLog(t.db, inst(a), { action: "run.cancel", target: "x" });
    expect(entry.installationId).toBe(inst(a));
    expect((await listAuditLog(t.db, [inst(v)])).items).toHaveLength(before);
  },
};

describe("tenant isolation", () => {
  describe.each([
    ["A", "B"],
    ["B", "A"],
  ] as const)("reads scoped to %s never return data of %s", (viewer, owner) => {
    const get = (k: string) => (k === "A" ? A : B);
    it.each(Object.keys(readCases))("%s", async (name) => {
      await readCases[name]!(get(viewer), get(owner));
    });
  });

  describe.each([
    ["A", "B"],
    ["B", "A"],
  ] as const)("writes by %s cannot touch data of %s", (actor, victim) => {
    const get = (k: string) => (k === "A" ? A : B);
    it.each(Object.keys(writeCases))("%s", async (name) => {
      await writeCases[name]!(get(actor), get(victim));
    });
  });

  it("treats an empty or malformed scope as seeing nothing, never as seeing everything", async () => {
    for (const scope of [[], ["not-a-uuid"], ["' or true --"]]) {
      expect(await listInstallations(t.db, scope)).toEqual([]);
      expect(await listRepositories(t.db, scope)).toEqual([]);
      expect((await listRuns(t.db, scope)).items).toEqual([]);
      expect((await listFindings(t.db, scope, { includeSuppressed: true })).items).toEqual([]);
      expect(await listProviderCredentials(t.db, scope)).toEqual([]);
      expect((await listAuditLog(t.db, scope)).items).toEqual([]);
    }
  });

  it("treats malformed ids as not found instead of failing in the database", async () => {
    const scope = [inst(A)];
    expect(await getRun(t.db, scope, "nope")).toBeUndefined();
    expect(await getRepository(t.db, scope, "nope")).toBeUndefined();
    expect(await getFinding(t.db, scope, "nope")).toBeUndefined();
    expect(await listFeedback(t.db, scope, "nope")).toEqual([]);
    await expect(
      setFeedback(t.db, inst(A), { findingId: "nope", userId: "nope", verdict: "useful" }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(insertFindings(t.db, "nope", "nope", [sampleFinding()])).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      upsertRepoSettings(t.db, inst(A), A.tenant.repo.id, { not_a_key: 1 }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("is enforced by the database for writers that bypass the data layer (composite foreign keys)", async () => {
    // A run of installation A pointing at a repository of installation B.
    await expect(
      t.pool.query(
        `insert into review_runs (installation_id, repo_id, pr_number, head_sha, base_sha, base_ref, trigger)
         values ($1, $2, 1, 'h', 'b', 'main', 'pull_request')`,
        [inst(A), B.tenant.repo.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    // A finding of installation A under a run of installation B.
    await expect(
      t.pool.query(
        `insert into findings (installation_id, run_id, repo_id, agent, category, severity, confidence,
                               title, evidence, impact, recommendation, fingerprint)
         values ($1, $2, $3, 'code_review', 'bug', 'high', 0.9, 't', 'e', 'i', 'r', 'fp')`,
        [inst(A), B.full.run.id, A.tenant.repo.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    // Feedback of installation A on a finding of installation B.
    await expect(
      t.pool.query(
        `insert into finding_feedback (finding_id, installation_id, user_id, verdict)
         values ($1, $2, $3, 'useful')`,
        [B.full.finding.id, inst(A), A.tenant.user.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("has a case for every function the tenant layer exports (add one when you add a function)", () => {
    const exported = Object.entries(tenantApi)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name);
    const covered = new Set([...Object.keys(readCases), ...Object.keys(writeCases)]);
    expect(exported.filter((name) => !covered.has(name))).toEqual([]);
    expect([...covered].filter((name) => !exported.includes(name))).toEqual([]);
    // Every function takes the database first and the caller scope second: installation ids (reads)
    // or one installation id (writes). Spot-check the arity convention.
    for (const name of exported) {
      expect(
        (tenantApi as Record<string, (...a: unknown[]) => unknown>)[name]!.length,
      ).toBeGreaterThanOrEqual(2);
    }
  });
});
