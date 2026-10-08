// Phase 15 in the api: abuse limits on the webhook endpoint, quotas and queue limits that leave a visible record
// (AC-23), the uninstall and suspend flows (AC-22), a burst of pull request events, and `/metrics`.
// Real PostgreSQL, the real app, a fake GitHub.
import { getWebhookDelivery, purgeDeletedInstallations } from "@ai-pr-review/db/system";
import { putProviderCredential, listProviderCredentials, getRun } from "@ai-pr-review/db";
import { makeFullRun, makeRun, makeRunInStatus, type Tenant } from "@ai-pr-review/db/testing";
import { MemoryRateLimitBoard } from "@ai-pr-review/queue";
import { QUEUE_LIMIT, QUOTA_EXCEEDED } from "@ai-pr-review/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectMetrics } from "./metrics/collect";
import { createHarness, createWorld, type Harness, type World } from "./testing/harness";
import { createQuotaCheck } from "./webhooks/quota";
import { fixture, prEvent, sha, type Json } from "./webhooks/testing";

let h: Harness;
let world: World;

afterEach(async () => {
  await h?.close();
});

/** A pull request event that belongs to one of the world's tenants (installation and repository ids match). */
function prFor(tenant: Tenant, number: number, headSha = sha(number % 9)): Json {
  return {
    ...prEvent("opened", { number, headSha }),
    installation: { id: tenant.installation.githubInstallationId },
    repository: {
      id: tenant.repo.githubRepoId,
      full_name: tenant.repo.fullName,
      name: tenant.repo.fullName.split("/")[1],
      private: true,
      default_branch: "main",
      owner: { login: tenant.installation.accountLogin, id: 1, type: "Organization" },
    },
  };
}

const lifecycle = (tenant: Tenant, action: string): Json => ({
  ...fixture("installation.created", { action }),
  installation: {
    id: tenant.installation.githubInstallationId,
    account: { login: tenant.installation.accountLogin, id: 1, type: "Organization" },
  },
});

async function statusOf(runId: string): Promise<{ status: string; reason: string | null }> {
  const { rows } = await h.t.pool.query(
    "select status, status_reason from review_runs where id = $1",
    [runId],
  );
  return { status: rows[0].status, reason: rows[0].status_reason };
}

describe("rate limits on the webhook endpoint", () => {
  beforeEach(async () => {
    h = await createHarness({
      webhooks: {
        limits: { perIpPerMinute: 3, badSignaturePerMinute: 2, perInstallationPerMinute: 2 },
      },
    });
    world = await createWorld(h);
  }, 60_000);

  it("limits requests per client address, with Retry-After, and leaves other addresses alone", async () => {
    const results: number[] = [];
    for (let i = 0; i < 4; i++)
      results.push((await h.postWebhook("ping", { zen: "x" }, { ip: "203.0.113.5" })).statusCode);
    expect(results).toEqual([202, 202, 202, 429]);

    const refused = await h.postWebhook("ping", { zen: "x" }, { ip: "203.0.113.5" });
    expect(refused.json().error.code).toBe("rate_limited");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);

    expect((await h.postWebhook("ping", { zen: "x" }, { ip: "203.0.113.6" })).statusCode).toBe(202);

    // The window passes: the first address may deliver again.
    h.clock.advance(61_000);
    expect((await h.postWebhook("ping", { zen: "x" }, { ip: "203.0.113.5" })).statusCode).toBe(202);
  });

  it("tells a forger to stop: invalid signatures are 401, then 429 once the address has sent too many", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await h.postWebhook(
        "ping",
        { zen: "x" },
        { ip: "198.51.100.9", signature: "sha256=00" },
      );
      statuses.push(res.statusCode);
    }
    expect(statuses).toEqual([401, 401, 429]);
    // Nothing a forger sent was recorded or queued.
    expect(h.queue.jobs).toEqual([]);
    expect(
      (await h.t.pool.query("select count(*)::int as n from webhook_deliveries")).rows[0].n,
    ).toBe(0);
    expect(h.logLines.join("\n")).toContain("too many invalid signatures");
  });

  it("limits the events one installation may cause and does not record the refused delivery, so redelivery works", async () => {
    const alpha = world.alpha;
    const send = (n: number) =>
      h.postWebhook("pull_request", prFor(alpha, n), {
        deliveryId: `alpha-${n}`,
        ip: `192.0.2.${n}`,
      });
    expect((await send(1)).statusCode).toBe(202);
    expect((await send(2)).statusCode).toBe(202);
    const refused = await send(3);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("installation_rate_limited");
    expect(await getWebhookDelivery(h.t.db, "alpha-3")).toBeUndefined();

    // Another installation is unaffected: one account's storm does not use up everyone's capacity.
    const beta = await h.postWebhook("pull_request", prFor(world.beta, 1), {
      deliveryId: "beta-1",
      ip: "192.0.2.99",
    });
    expect(beta.statusCode).toBe(202);

    // After the window the refused delivery can be redelivered and is processed normally.
    h.clock.advance(61_000);
    expect((await send(3)).statusCode).toBe(202);
    await h.webhookService!.idle();
    expect((await getWebhookDelivery(h.t.db, "alpha-3"))?.outcome).toBe("run_queued");
  });

  it("counts every outcome for /metrics", async () => {
    await h.postWebhook("ping", { zen: "x" }, { ip: "203.0.113.7" });
    await h.postWebhook("ping", { zen: "x" }, { ip: "203.0.113.7", signature: "sha256=00" });
    const text = h.metrics.webhooks
      .family()
      .samples.map((s) => `${s.labels?.["result"]}=${s.value}`);
    expect(text).toEqual(expect.arrayContaining(["accepted=1", "invalid_signature=1"]));
  });
});

describe("quotas and queue limits leave a visible record (AC-23)", () => {
  async function build(options: {
    runsPerDay?: number;
    perInstallation?: number;
    global?: number;
  }) {
    // The quota hook needs the database, which exists only once the harness does: it reads the harness lazily.
    const hook: { check?: ReturnType<typeof createQuotaCheck> } = {};
    h = await createHarness({
      webhooks: {
        quota: (input) => hook.check!(input),
      },
    });
    hook.check = createQuotaCheck({
      db: h.t.db,
      quotas: { runsPerDay: options.runsPerDay ?? 1000, tokensPerDay: 10_000_000 },
      queue: {
        perInstallation: options.perInstallation ?? 1000,
        global: options.global ?? 100_000,
      },
      now: h.clock.now,
    });
    world = await createWorld(h);
  }

  const deliver = async (tenant: Tenant, n: number) => {
    const res = await h.postWebhook("pull_request", prFor(tenant, n), {
      deliveryId: `d-${tenant.label}-${n}`,
    });
    expect(res.statusCode).toBe(202);
    await h.webhookService!.idle();
  };

  it("the daily quota stops new runs and records a skipped run with the reason, shown in the dashboard", async () => {
    await build({ runsPerDay: 2 });
    await deliver(world.alpha, 1);
    await deliver(world.alpha, 2);
    await deliver(world.alpha, 3);

    const { rows } = await h.t.pool.query(
      "select pr_number, status, status_reason from review_runs order by pr_number",
    );
    expect(rows.map((r) => [r.pr_number, r.status])).toEqual([
      [1, "queued"],
      [2, "queued"],
      [3, "skipped"],
    ]);
    expect(rows[2].status_reason).toContain(QUOTA_EXCEEDED);
    expect(h.queue.jobs).toHaveLength(2);

    const alice = await h.signIn(world.alice);
    const listed = (await h.request(alice, "GET", "/api/runs?status=skipped")).json();
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0].status_reason).toContain(QUOTA_EXCEEDED);
  });

  it("the queue limit of an installation skips the run that would be one too many, and not other installations'", async () => {
    await build({ perInstallation: 2 });
    for (const n of [1, 2, 3]) await deliver(world.alpha, n);
    await deliver(world.beta, 1);

    const { rows } = await h.t.pool.query(
      "select r.pr_number, r.status, r.status_reason, i.account_login from review_runs r join installations i on i.id = r.installation_id order by i.account_login, r.pr_number",
    );
    const byTenant = (login: string) => rows.filter((r) => r.account_login === login);
    expect(byTenant(world.alpha.installation.accountLogin).map((r) => r.status)).toEqual([
      "queued",
      "queued",
      "skipped",
    ]);
    expect(byTenant(world.alpha.installation.accountLogin)[2].status_reason).toContain(QUEUE_LIMIT);
    expect(byTenant(world.beta.installation.accountLogin).map((r) => r.status)).toEqual(["queued"]);
  });

  it("the global queue limit protects the platform as a whole", async () => {
    await build({ global: 2 });
    await deliver(world.alpha, 1);
    await deliver(world.beta, 1);
    await deliver(world.alpha, 2);
    const { rows } = await h.t.pool.query(
      "select status, status_reason from review_runs order by queued_at, id",
    );
    expect(rows.map((r) => r.status)).toEqual(["queued", "queued", "skipped"]);
    expect(rows[2].status_reason).toContain("queue is full");
  });

  it("a run that finishes frees its place in the queue", async () => {
    await build({ perInstallation: 1 });
    await deliver(world.alpha, 1);
    await deliver(world.alpha, 2); // skipped: the queue holds one
    const first = (await h.t.pool.query("select id from review_runs where pr_number = 1")).rows[0]
      .id;
    await h.t.pool.query(
      "update review_runs set status = 'cancelled', finished_at = now() where id = $1",
      [first],
    );
    await deliver(world.alpha, 3);
    const { rows } = await h.t.pool.query(
      "select pr_number, status from review_runs order by pr_number",
    );
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "skipped", "queued"]);
  });
});

describe("uninstall and suspend (AC-22, PL-08)", () => {
  beforeEach(async () => {
    h = await createHarness({ webhooks: {} });
    world = await createWorld(h);
  }, 60_000);

  async function seed(tenant: Tenant) {
    const queued = await makeRun(h.t.db, tenant, { repo: tenant.repo2 });
    const running = await makeRunInStatus(h.t.db, tenant, "running", { repo: tenant.repo2 });
    const done = await makeRunInStatus(h.t.db, tenant, "completed", { repo: tenant.repo2 });
    await putProviderCredential(h.t.db, tenant.installation.id, {
      provider: "deepseek",
      ciphertext: Buffer.from("sealed"),
      keyVersion: 1,
      last4: "abcd",
    });
    return { queued, running, done };
  }

  it("uninstall: stops what was waiting, forgets the keys and who could see the data, hides everything, and keeps history until retention ends", async () => {
    const alpha = world.alpha;
    const { queued, running, done } = await seed(alpha);
    const alice = await h.signIn(world.alice);
    expect((await h.request(alice, "GET", `/api/runs/${done.id}`)).statusCode).toBe(200);

    const res = await h.postWebhook("installation", lifecycle(alpha, "deleted"));
    expect(res.statusCode).toBe(202);
    await h.webhookService!.idle();

    // Stopped, with the reason, and the dashboard and any worker were told.
    for (const run of [queued, running]) {
      const now = await statusOf(run.id);
      expect(now.status).toBe("cancelled");
      expect(now.reason).toContain("uninstalled");
    }
    expect((await statusOf(done.id)).status).toBe("completed");
    expect(h.signals.cancelled.map((c) => c.runId).sort()).toEqual([queued.id, running.id].sort());
    expect(h.signals.updated.filter((u) => u.status === "cancelled")).toHaveLength(2);

    // The keys and the access caches are gone at once...
    expect(await listProviderCredentials(h.t.db, [alpha.installation.id])).toEqual([]);
    const access = await h.t.pool.query(
      "select count(*)::int as n from user_installations where installation_id = $1",
      [alpha.installation.id],
    );
    expect(access.rows[0].n).toBe(0);

    // ...the dashboard shows nothing of it, though the session is still alive (AC-22).
    expect((await h.request(alice, "GET", "/api/repos")).json().items).toEqual([]);
    expect((await h.request(alice, "GET", `/api/runs/${done.id}`)).statusCode).toBe(404);
    expect((await h.request(alice, "GET", "/api/runs")).json().items).toEqual([]);
    expect((await h.request(alice, "GET", "/api/me")).json().installations).toEqual([]);

    // The history is kept for the retention window...
    expect(await getRun(h.t.db, [alpha.installation.id], done.id)).toBeDefined();
    expect(await purgeDeletedInstallations(h.t.db, 90)).toBe(0);
    // ...and removed when it ends, with everything the installation owned.
    await h.t.pool.query(
      "update installations set status_changed_at = now() - interval '91 days' where id = $1",
      [alpha.installation.id],
    );
    expect(await purgeDeletedInstallations(h.t.db, 90)).toBe(1);
    expect(await getRun(h.t.db, [alpha.installation.id], done.id)).toBeUndefined();
    expect(
      (
        await h.t.pool.query(
          "select count(*)::int as n from review_runs where installation_id = $1",
          [alpha.installation.id],
        )
      ).rows[0].n,
    ).toBe(0);
    // Another tenant is untouched.
    expect(
      (
        await h.t.pool.query("select count(*)::int as n from installations where id = $1", [
          world.beta.installation.id,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it("a delivery after uninstall creates no run (the installation is gone)", async () => {
    await h.postWebhook("installation", lifecycle(world.alpha, "deleted"));
    await h.webhookService!.idle();
    await h.postWebhook("pull_request", prFor(world.alpha, 41));
    await h.webhookService!.idle();
    const { rows } = await h.t.pool.query(
      "select count(*)::int as n from review_runs where pr_number = 41",
    );
    expect(rows[0].n).toBe(0);
  });

  it("suspend: stops what was waiting and hides the data, but keeps keys and access so unsuspend restores it", async () => {
    const alpha = world.alpha;
    const { queued, done } = await seed(alpha);
    const alice = await h.signIn(world.alice);

    await h.postWebhook("installation", lifecycle(alpha, "suspend"));
    await h.webhookService!.idle();

    expect((await statusOf(queued.id)).reason).toContain("suspended");
    expect((await h.request(alice, "GET", "/api/repos")).json().items).toEqual([]);
    expect((await h.request(alice, "GET", `/api/runs/${done.id}`)).statusCode).toBe(404);
    expect(await listProviderCredentials(h.t.db, [alpha.installation.id])).toHaveLength(1);
    // Suspension is never purged, however long it lasts.
    await h.t.pool.query(
      "update installations set status_changed_at = now() - interval '999 days' where id = $1",
      [alpha.installation.id],
    );
    expect(await purgeDeletedInstallations(h.t.db, 1)).toBe(0);

    await h.postWebhook("installation", lifecycle(alpha, "unsuspend"));
    await h.webhookService!.idle();
    expect((await h.request(alice, "GET", "/api/repos")).json().items).toHaveLength(2);
    expect((await h.request(alice, "GET", `/api/runs/${done.id}`)).statusCode).toBe(200);
    // The stopped review is not resurrected: a push or a re-run starts a new one.
    expect((await statusOf(queued.id)).status).toBe("cancelled");
  });

  it("removed GitHub access shows up within the cache lifetime (AC-17)", async () => {
    const alpha = world.alpha;
    const alice = await h.signIn(world.alice);
    expect((await h.request(alice, "GET", "/api/repos")).json().items).toHaveLength(2);

    // GitHub no longer says alice may see the organization; the cache still does until it expires.
    h.github.repoPermissions.set(`alice|${alpha.repo.fullName}`, "none");
    h.github.repoPermissions.set(`alice|${alpha.repo2.fullName}`, "none");
    h.github.orgRoles.set(`alice|${alpha.installation.accountLogin}`, "none");
    expect((await h.request(alice, "GET", "/api/repos")).json().items).toHaveLength(2);

    h.clock.advance(h.config.accessCacheTtlMs + 1000);
    const after = await h.request(alice, "GET", "/api/repos");
    expect(after.json().items).toEqual([]);
    expect((await h.request(alice, "GET", `/api/repos/${alpha.repo.id}`)).statusCode).toBe(404);
    expect(
      (await h.request(alice, "GET", `/api/installations/${alpha.installation.id}/settings`))
        .statusCode,
    ).toBe(404);
  });
});

describe("a burst of pull request events (load, PL-05)", () => {
  async function burst(options: { perInstallation: number; count?: number }) {
    const hook: { check?: ReturnType<typeof createQuotaCheck> } = {};
    h = await createHarness({
      webhooks: {
        quota: (input) => hook.check!(input),
        limits: { perIpPerMinute: 10_000, perInstallationPerMinute: 10_000 },
      },
    });
    hook.check = createQuotaCheck({
      db: h.t.db,
      quotas: { runsPerDay: 100_000, tokensPerDay: 100_000_000 },
      queue: { perInstallation: options.perInstallation, global: 100_000 },
      now: h.clock.now,
    });
    world = await createWorld(h);
    const count = options.count ?? 200;
    const started = Date.now();
    const responses = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        h.postWebhook("pull_request", prFor(world.alpha, i + 1, sha((i % 9) + 1)), {
          deliveryId: `burst-${i + 1}`,
        }),
      ),
    );
    await h.webhookService!.idle();
    return { responses, count, ms: Date.now() - started };
  }

  it("200 events in a burst: every one is answered 202 and becomes a run, none is dropped, each queued run has one job", async () => {
    const { responses, count } = await burst({ perInstallation: 1000 });
    expect(responses.every((r) => r.statusCode === 202)).toBe(true);

    const { rows } = await h.t.pool.query(
      "select status, count(*)::int as n from review_runs group by status",
    );
    expect(Object.fromEntries(rows.map((r) => [r.status, r.n]))).toEqual({ queued: count });
    expect(new Set(h.queue.jobs).size).toBe(count);
    const distinct = await h.t.pool.query(
      "select count(distinct pr_number)::int as n from review_runs",
    );
    expect(distinct.rows[0].n).toBe(count);

    // Every delivery was recorded and processed once.
    const outcomes = await h.t.pool.query(
      "select outcome, count(*)::int as n from webhook_deliveries group by outcome",
    );
    expect(Object.fromEntries(outcomes.rows.map((r) => [r.outcome, r.n]))).toEqual({
      run_queued: count,
    });
  }, 120_000);

  it("the same 200 deliveries sent again create nothing new (AC-14 under load)", async () => {
    const { count } = await burst({ perInstallation: 1000 });
    const again = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        h.postWebhook("pull_request", prFor(world.alpha, i + 1, sha((i % 9) + 1)), {
          deliveryId: `burst-${i + 1}`,
        }),
      ),
    );
    await h.webhookService!.idle();
    expect(again.every((r) => r.statusCode === 202 && r.json().status === "duplicate")).toBe(true);
    expect((await h.t.pool.query("select count(*)::int as n from review_runs")).rows[0].n).toBe(
      count,
    );
    expect(new Set(h.queue.jobs).size).toBe(count);
  }, 120_000);

  it("with the production queue limit the overflow is recorded as skipped runs with a reason: every event is accounted for", async () => {
    const { count } = await burst({ perInstallation: 100 });
    const { rows } = await h.t.pool.query(
      "select status, count(*)::int as n from review_runs group by status",
    );
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    expect(by["queued"] + by["skipped"]).toBe(count);
    // The limit is decided inside the transaction that creates the run, so concurrent events cannot overshoot it.
    expect(by["queued"]).toBe(100);
    expect(by["skipped"]).toBe(count - 100);
    expect(h.queue.jobs).toHaveLength(100);
    const reasons = await h.t.pool.query(
      "select distinct status_reason from review_runs where status = 'skipped'",
    );
    expect(reasons.rows.every((r) => String(r.status_reason).startsWith(QUEUE_LIMIT))).toBe(true);
  }, 120_000);
});

describe("GET /metrics", () => {
  const TOKEN = "metrics-token-0123456789";
  const board = new MemoryRateLimitBoard();

  beforeEach(async () => {
    h = await createHarness({
      webhooks: {},
      app: {
        metrics: {
          token: TOKEN,
          collect: async () =>
            collectMetrics({
              db: h.t.db,
              queue: {
                counts: async () => ({ waiting: 3, active: 1, delayed: 0, failed: 0 }),
                deadLetterCount: async () => 2,
              },
              rateLimits: board,
              rowSecurity: async () => ({ role: "aipr_app", enforced: true }),
              counters: h.metrics,
              staleAfterSeconds: 120,
            }),
        },
      },
    });
    world = await createWorld(h);
  }, 60_000);

  const scrape = (token?: string) =>
    h.app.inject({
      method: "GET",
      url: "/metrics",
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });

  it("needs the bearer token, and says nothing else without it", async () => {
    for (const token of [undefined, "wrong", `${TOKEN}x`, TOKEN.slice(1)]) {
      const res = await scrape(token);
      expect(res.statusCode, String(token)).toBe(401);
      expect(res.headers["www-authenticate"]).toBe("Bearer");
      expect(res.body).not.toContain("aipr_");
    }
  });

  it("reports queue depth, run durations and failure rate, webhook health and the GitHub rate limit in the text format", async () => {
    await makeRun(h.t.db, world.alpha);
    await makeRunInStatus(h.t.db, world.alpha, "completed");
    await makeRunInStatus(h.t.db, world.alpha, "failed");
    board.record({
      installationId: 4242,
      limit: 5000,
      remaining: 100,
      resetAt: Math.floor(Date.now() / 1000) + 600,
    });
    await h.postWebhook("ping", { zen: "x" });

    const res = await scrape(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(res.headers["cache-control"]).toBe("no-store");
    const text = res.body;
    expect(text).toMatch(/^aipr_runs_active\{status="queued"\} 1$/m);
    expect(text).toMatch(/^aipr_runs_finished_24h\{status="failed"\} 1$/m);
    expect(text).toMatch(/^aipr_run_failure_ratio_24h 0\.5$/m);
    expect(text).toMatch(/^aipr_queue_jobs\{state="waiting"\} 3$/m);
    expect(text).toMatch(/^aipr_dead_letter_jobs 2$/m);
    expect(text).toMatch(/^aipr_github_rate_limit_remaining\{installation="4242"\} 100$/m);
    expect(text).toMatch(/^aipr_row_level_security_enforced 1$/m);
    expect(text).toMatch(/^aipr_dependency_up\{dependency="postgres"\} 1$/m);
    expect(text).toMatch(/^aipr_webhook_requests_total\{result="accepted"\} 1$/m);
    expect(text).toMatch(/^# TYPE aipr_oldest_queued_run_age_seconds gauge$/m);
    // Every line is a comment or `name{labels} number`.
    for (const line of text.trim().split("\n")) {
      expect(line).toMatch(/^(#.*|[a-z0-9_]+(\{[^}]*\})? -?[0-9.e+-]+)$/);
    }
  });

  it("names no repository, user, branch or finding of any tenant", async () => {
    await makeFullRun(h.t.db, world.alpha);
    const text = (await scrape(TOKEN)).body;
    for (const secret of [
      world.alpha.repo.fullName,
      world.alpha.installation.accountLogin,
      "octocat",
      "Finding",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("still answers when the database does not, and says so", async () => {
    const broken = await collectMetrics({
      db: {
        execute: async () => {
          throw new Error("down");
        },
      } as never,
      counters: h.metrics,
      staleAfterSeconds: 120,
    });
    expect(broken).toMatch(/^aipr_dependency_up\{dependency="postgres"\} 0$/m);
    expect(broken).toMatch(/^aipr_up 1$/m);
  });
});
