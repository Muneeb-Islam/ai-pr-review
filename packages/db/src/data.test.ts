// Behaviour of the data layer that is not about isolation, lifecycle, pagination or retention.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_MAX_CHARS } from "./schema";
import {
  getInstallationByGitHubId,
  listAccessibleInstallationIds,
  markWebhookDeliveryProcessed,
  recordWebhookDelivery,
  replaceUserInstallations,
  setInstallationStatus,
  upsertInstallationFromGitHub,
  upsertUser,
  getRunById,
} from "./system";
import {
  countSuppressedFindings,
  createRun,
  getRepoSettings,
  insertFindings,
  listFeedback,
  listFindings,
  listFindingsForRun,
  listRepositories,
  listRuns,
  listRunsForPullRequest,
  markFindingsPosted,
  setFeedback,
  setRepositoriesActive,
  setRepositoryEnabled,
  upsertRepoSettings,
  upsertRepository,
} from "./tenant";
import { InvalidInputError, NotFoundError } from "./errors";
import {
  createTenant,
  makeFullRun,
  makeRun,
  makeRunInStatus,
  sampleFinding,
  type Tenant,
} from "./testing/fixtures";
import { createTestDatabase, type TestDatabase } from "./testing/testDb";

let t: TestDatabase;
let A: Tenant;

beforeAll(async () => {
  t = await createTestDatabase();
  A = await createTenant(t.db, "alpha");
}, 30_000);
afterAll(async () => {
  await t.drop();
});

describe("data minimisation", () => {
  it("has no column that could hold a diff or a file's contents", async () => {
    const { rows } = await t.pool.query(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and table_name <> '__drizzle_migrations'`,
    );
    const suspicious = rows.filter((r) =>
      /diff|patch|content|source|body|blob|snippet|file_text|code/.test(r.column_name),
    );
    expect(suspicious).toEqual([]);
  });

  it("limits findings.evidence to 500 characters in the data layer", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    const [long, exact, short, emoji] = await insertFindings(t.db, A.installation.id, run.id, [
      sampleFinding({ evidence: "x".repeat(600) }),
      sampleFinding({ evidence: "y".repeat(EVIDENCE_MAX_CHARS) }),
      sampleFinding({ evidence: "short" }),
      // 600 astral characters: counted as characters, not UTF-16 units, and still within varchar(500).
      sampleFinding({ evidence: "😀".repeat(600) }),
    ]);
    expect(long!.evidence).toHaveLength(500);
    expect(exact!.evidence).toHaveLength(500);
    expect(short!.evidence).toBe("short");
    expect(Array.from(emoji!.evidence)).toHaveLength(500);
  });

  it("limits findings.evidence to 500 characters in the database as well", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    const insert = (evidence: string) =>
      t.pool.query(
        `insert into findings (installation_id, run_id, repo_id, agent, category, severity, confidence,
                               title, evidence, impact, recommendation, fingerprint)
         values ($1, $2, $3, 'code_review', 'bug', 'high', 0.9, 't', $4, 'i', 'r', 'fp')`,
        [A.installation.id, run.id, run.repoId, evidence],
      );
    await expect(insert("z".repeat(501))).rejects.toMatchObject({ code: "22001" });
    await expect(insert("z".repeat(500))).resolves.toBeDefined();
  });
});

describe("findings", () => {
  it("lists the most severe first and hides suppressed findings unless asked", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    await insertFindings(t.db, A.installation.id, run.id, [
      sampleFinding({ severity: "low", title: "low" }),
      sampleFinding({ severity: "critical", title: "critical" }),
      sampleFinding({ severity: "info", title: "info", suppressedReason: "style_only" }),
      sampleFinding({ severity: "high", title: "high", suppressedReason: "duplicate" }),
      sampleFinding({ severity: "medium", title: "medium" }),
    ]);
    const visible = await listFindingsForRun(t.db, [A.installation.id], run.id);
    expect(visible.map((f) => f.title)).toEqual(["critical", "medium", "low"]);
    const all = await listFindingsForRun(t.db, [A.installation.id], run.id, {
      includeSuppressed: true,
    });
    expect(all.map((f) => f.title)).toEqual(["critical", "high", "medium", "low", "info"]);
    expect(await countSuppressedFindings(t.db, [A.installation.id], run.id)).toEqual({
      style_only: 1,
      duplicate: 1,
    });
  });

  it("filters the explorer by severity, category and agent", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    await insertFindings(t.db, A.installation.id, run.id, [
      sampleFinding({ severity: "critical", category: "security", agent: "security" }),
      sampleFinding({ severity: "low", category: "test_gap", agent: "test_coverage" }),
    ]);
    const only = (filters: Parameters<typeof listFindings>[2]) =>
      listFindings(t.db, [A.installation.id], { runId: run.id, ...filters });
    expect((await only({ severity: "critical" })).items).toHaveLength(1);
    expect((await only({ severity: ["critical", "low"] })).items).toHaveLength(2);
    expect((await only({ severity: [] })).items).toHaveLength(0);
    expect((await only({ category: "test_gap" })).items).toHaveLength(1);
    expect((await only({ agent: "security" })).items).toHaveLength(1);
  });

  it("refuses to store a finding that is both suppressed and posted", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    await expect(
      insertFindings(t.db, A.installation.id, run.id, [
        sampleFinding({ posted: true, suppressedReason: "duplicate" }),
      ]),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("marks findings as posted but never a suppressed one", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    const [ok, suppressed] = await insertFindings(t.db, A.installation.id, run.id, [
      sampleFinding(),
      sampleFinding({ suppressedReason: "no_evidence" }),
    ]);
    expect(await markFindingsPosted(t.db, A.installation.id, [ok!.id, suppressed!.id])).toBe(1);
  });

  it("stores an empty list as no rows", async () => {
    const run = await makeRunInStatus(t.db, A, "running");
    expect(await insertFindings(t.db, A.installation.id, run.id, [])).toEqual([]);
  });
});

describe("feedback", () => {
  it("keeps one verdict per user and finding, replacing it on change", async () => {
    const { finding } = await makeFullRun(t.db, A);
    await setFeedback(t.db, A.installation.id, {
      findingId: finding.id,
      userId: A.user.id,
      verdict: "false_positive",
      note: "validated upstream",
    });
    const feedback = await listFeedback(t.db, [A.installation.id], finding.id);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ verdict: "false_positive", note: "validated upstream" });

    const other = await upsertUser(t.db, { githubUserId: 777, login: "other" });
    await setFeedback(t.db, A.installation.id, {
      findingId: finding.id,
      userId: other.id,
      verdict: "known",
    });
    expect(await listFeedback(t.db, [A.installation.id], finding.id)).toHaveLength(2);
  });
});

describe("repositories and settings", () => {
  it("upserts repositories per installation and reactivates removed ones without touching enabled", async () => {
    const input = {
      githubRepoId: 4242,
      fullName: "alpha/new",
      defaultBranch: "main",
      isPrivate: true,
    };
    const created = await upsertRepository(t.db, A.installation.id, input);
    expect(created).toMatchObject({ enabled: true, active: true });

    await setRepositoryEnabled(t.db, A.installation.id, created.id, false);
    expect(await setRepositoriesActive(t.db, A.installation.id, [4242, 999_999], false)).toBe(1);
    const renamed = await upsertRepository(t.db, A.installation.id, {
      ...input,
      fullName: "alpha/renamed",
      defaultBranch: "trunk",
    });
    expect(renamed).toMatchObject({
      id: created.id,
      fullName: "alpha/renamed",
      defaultBranch: "trunk",
      active: true,
      enabled: false,
    });
    const found = await listRepositories(t.db, [A.installation.id], {
      enabled: false,
      active: true,
    });
    expect(found.map((r) => r.id)).toEqual([created.id]);
  });

  it("validates settings and stores only what was given", async () => {
    const id = A.installation.id;
    const repoId = A.repo.id;
    const saved = await upsertRepoSettings(
      t.db,
      id,
      repoId,
      { review: { mode: "warn" }, provider: "deepseek", model: "m" },
      A.user.id,
    );
    expect(saved.config).toEqual({ review: { mode: "warn" }, provider: "deepseek", model: "m" });
    expect(saved.updatedBy).toBe(A.user.id);

    for (const bad of [
      { review: { mode: "yolo" } },
      { review: { minimum_confidence: 2 } },
      { unknown_key: true },
      { provider: "other" },
      { api_key: "sk-secret" },
    ]) {
      await expect(upsertRepoSettings(t.db, id, repoId, bad)).rejects.toBeInstanceOf(
        InvalidInputError,
      );
    }
    // A rejected update leaves the stored settings alone.
    expect((await getRepoSettings(t.db, [id], repoId))?.config).toEqual(saved.config);

    // Updating replaces the document.
    const replaced = await upsertRepoSettings(t.db, id, repoId, { fork_prs: "review" });
    expect(replaced.config).toEqual({ fork_prs: "review" });
    expect(replaced.updatedAt.getTime()).toBeGreaterThanOrEqual(saved.updatedAt.getTime());
  });
});

describe("runs", () => {
  it("lists a pull request's runs and filters the run list", async () => {
    const t0 = new Date("2033-01-01T00:00:00.000Z");
    const r1 = await makeRun(t.db, A, { prNumber: 900, at: t0 });
    const r2 = await makeRunInStatus(t.db, A, "completed", {
      prNumber: 900,
      headSha: r1.headSha,
      at: new Date(t0.getTime() + 60_000),
    });
    const r3 = await makeRunInStatus(t.db, A, "failed", {
      prNumber: 901,
      repo: A.repo2,
      at: new Date(t0.getTime() + 120_000),
    });
    const ids = [A.installation.id];

    expect((await listRunsForPullRequest(t.db, ids, A.repo.id, 900)).map((r) => r.id)).toEqual([
      r2.id,
      r1.id,
    ]);
    expect(await listRunsForPullRequest(t.db, ids, A.repo.id, 900, { headSha: "nope" })).toEqual(
      [],
    );
    expect(
      (await listRunsForPullRequest(t.db, ids, A.repo.id, 900, { status: "queued" })).map(
        (r) => r.id,
      ),
    ).toEqual([r1.id]);

    const window = { from: t0, to: new Date(t0.getTime() + 120_000) };
    expect((await listRuns(t.db, ids, window)).items.map((r) => r.id)).toEqual([
      r3.id,
      r2.id,
      r1.id,
    ]);
    expect(
      (await listRuns(t.db, ids, { ...window, repoId: A.repo2.id })).items.map((r) => r.id),
    ).toEqual([r3.id]);
    expect(
      (await listRuns(t.db, ids, { ...window, status: ["queued", "failed"] })).items.map(
        (r) => r.id,
      ),
    ).toEqual([r3.id, r1.id]);
    expect((await listRuns(t.db, ids, { status: [] })).items).toEqual([]);
    expect((await listRuns(t.db, ids, { ...window, baseRef: "release" })).items).toEqual([]);
    expect((await listRuns(t.db, ids, { ...window, triggeredBy: "octocat" })).items).toHaveLength(
      3,
    );
  });

  it("filters runs by the severity of their findings, ignoring suppressed ones", async () => {
    const withCritical = await makeRunInStatus(t.db, A, "running");
    await insertFindings(t.db, A.installation.id, withCritical.id, [
      sampleFinding({ severity: "critical" }),
    ]);
    const onlySuppressed = await makeRunInStatus(t.db, A, "running");
    await insertFindings(t.db, A.installation.id, onlySuppressed.id, [
      sampleFinding({ severity: "critical", suppressedReason: "duplicate" }),
    ]);
    const ids = (
      await listRuns(t.db, [A.installation.id], { severity: "critical", limit: 100 })
    ).items.map((r) => r.id);
    expect(ids).toContain(withCritical.id);
    expect(ids).not.toContain(onlySuppressed.id);
  });

  it("links a re-run to its parent in the same installation", async () => {
    const parent = await makeRunInStatus(t.db, A, "completed");
    const rerun = await createRun(t.db, A.installation.id, {
      repoId: parent.repoId,
      prNumber: parent.prNumber,
      headSha: parent.headSha,
      baseSha: parent.baseSha,
      baseRef: parent.baseRef,
      trigger: "dashboard_rerun",
      parentRunId: parent.id,
    });
    expect(rerun).toMatchObject({
      parentRunId: parent.id,
      trigger: "dashboard_rerun",
      status: "queued",
    });
    await expect(
      createRun(t.db, A.installation.id, {
        repoId: parent.repoId,
        prNumber: 1,
        headSha: "x",
        baseSha: "y",
        baseRef: "main",
        trigger: "pull_request",
        parentRunId: "00000000-0000-4000-8000-000000000000",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects invalid PR numbers", async () => {
    for (const prNumber of [0, -1, 1.5]) {
      await expect(
        createRun(t.db, A.installation.id, {
          repoId: A.repo.id,
          prNumber,
          headSha: "x",
          baseSha: "y",
          baseRef: "main",
          trigger: "pull_request",
        }),
      ).rejects.toBeInstanceOf(InvalidInputError);
    }
  });

  it("lets the worker load a run by id alone (system)", async () => {
    const run = await makeRun(t.db, A);
    expect(await getRunById(t.db, run.id)).toEqual(run);
    expect(await getRunById(t.db, "nope")).toBeUndefined();
  });
});

describe("system: webhooks, installations and user scope", () => {
  it("processes a repeated delivery id once, even when deliveries race", async () => {
    const first = await recordWebhookDelivery(t.db, {
      deliveryId: "delivery-1",
      event: "pull_request",
    });
    const again = await recordWebhookDelivery(t.db, {
      deliveryId: "delivery-1",
      event: "pull_request",
    });
    expect(first.firstSeen).toBe(true);
    expect(again.firstSeen).toBe(false);

    const racing = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordWebhookDelivery(t.db, { deliveryId: "delivery-2", event: "pull_request" }),
      ),
    );
    expect(racing.filter((r) => r.firstSeen)).toHaveLength(1);

    expect(
      await markWebhookDeliveryProcessed(t.db, "delivery-1", "queued", {
        installationId: A.installation.id,
      }),
    ).toBe(true);
    expect(await markWebhookDeliveryProcessed(t.db, "unknown", "queued")).toBe(false);
    const { rows } = await t.pool.query(
      "select * from webhook_deliveries where delivery_id = 'delivery-1'",
    );
    expect(rows[0]).toMatchObject({ outcome: "queued", installation_id: A.installation.id });
    expect(rows[0].processed_at).toBeInstanceOf(Date);
  });

  it("keeps installations unique by GitHub id and tracks their status", async () => {
    const a = await upsertInstallationFromGitHub(t.db, {
      githubInstallationId: 555,
      accountLogin: "acme",
      accountType: "organization",
    });
    const b = await upsertInstallationFromGitHub(t.db, {
      githubInstallationId: 555,
      accountLogin: "acme-renamed",
      accountType: "organization",
    });
    expect(b.id).toBe(a.id);
    expect(b).toMatchObject({ accountLogin: "acme-renamed", status: "active" });
    expect((await setInstallationStatus(t.db, 555, "deleted"))?.status).toBe("deleted");
    expect((await getInstallationByGitHubId(t.db, 555))?.status).toBe("deleted");
    expect(await setInstallationStatus(t.db, 556, "deleted")).toBeUndefined();
    // Re-installation (an upsert without a status) must not silently revive a deleted installation...
    expect(
      (
        await upsertInstallationFromGitHub(t.db, {
          githubInstallationId: 555,
          accountLogin: "acme",
          accountType: "organization",
        })
      ).status,
    ).toBe("deleted");
    // ...but an explicit status does.
    expect(
      (
        await upsertInstallationFromGitHub(t.db, {
          githubInstallationId: 555,
          accountLogin: "acme",
          accountType: "organization",
          status: "active",
        })
      ).status,
    ).toBe("active");
  });

  it("resolves the caller scope from active installations only", async () => {
    const user = await upsertUser(t.db, { githubUserId: 31337, login: "scoped" });
    const other = await createTenant(t.db, "gamma");
    const gone = await createTenant(t.db, "delta");
    await replaceUserInstallations(t.db, user.id, [
      { installationId: A.installation.id, role: "admin" },
      { installationId: other.installation.id, role: "viewer" },
      { installationId: gone.installation.id, role: "viewer" },
    ]);
    expect((await listAccessibleInstallationIds(t.db, user.id)).sort()).toEqual(
      [A.installation.id, other.installation.id, gone.installation.id].sort(),
    );

    // Uninstalled: the installation drops out of the user's scope (AC-22).
    await setInstallationStatus(t.db, gone.installation.githubInstallationId, "deleted");
    await setInstallationStatus(t.db, other.installation.githubInstallationId, "suspended");
    expect(await listAccessibleInstallationIds(t.db, user.id)).toEqual([A.installation.id]);

    // The refreshed GitHub access list replaces the cache: installations not in it are removed.
    await replaceUserInstallations(t.db, user.id, [
      { installationId: other.installation.id, role: "admin" },
    ]);
    expect(await listAccessibleInstallationIds(t.db, user.id)).toEqual([]);
    await replaceUserInstallations(t.db, user.id, []);
    const { rows } = await t.pool.query(
      "select count(*)::int as n from user_installations where user_id = $1",
      [user.id],
    );
    expect(rows[0].n).toBe(0);
  });
});
