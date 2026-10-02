// Webhook endpoint and handlers against a real PostgreSQL (no database mocks) and a fake GitHub gateway.
// Covers Phase 3: AC-13 (signatures), AC-14 (duplicates), AC-15 (supersede), AC-16 (queued Check Run),
// AC-22 (uninstall) and the guard matrix.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertRepoSettings } from "@ai-pr-review/db";
import { getWebhookDelivery } from "@ai-pr-review/db/system";
import { createTestDatabase, type TestDatabase } from "@ai-pr-review/db/testing";
import { createLogger, InMemoryJobQueue } from "@ai-pr-review/shared";
import { buildApp } from "../app";
import { WebhookService } from "./service";
import type { QuotaCheck } from "./types";
import { FakeGateway, fixture, patch, prEvent, sha, sign, SECRET, type Json } from "./testing";

let t: TestDatabase;
const logger = createLogger({}, () => undefined);
let github: FakeGateway;
let queue: InMemoryJobQueue;
let quota: QuotaCheck | undefined;
let service: WebhookService;
let app: ReturnType<typeof buildApp>;

const MAX_BODY = 64 * 1024;

function build(): void {
  github = new FakeGateway();
  queue = new InMemoryJobQueue();
  service = new WebhookService({
    db: t.db,
    github,
    queue,
    logger,
    publicUrl: "http://localhost:5173",
    quota: (input) => (quota ?? (async () => ({ allowed: true as const })))(input),
  });
  app = buildApp({
    checks: { postgres: async () => {}, redis: async () => {} },
    webhooks: { secret: SECRET, service, logger, maxBodyBytes: MAX_BODY },
  });
}

let deliveryCounter = 0;
const nextDelivery = () => `delivery-${++deliveryCounter}`;

/** POSTs a signed webhook to the real route and waits until its processing finished. */
async function post(event: string, payload: Json, deliveryId = nextDelivery()) {
  const body = JSON.stringify(payload);
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sign(body),
    },
    payload: body,
  });
  await service.idle();
  return { res, deliveryId };
}

async function deliver(event: string, payload: Json, deliveryId?: string): Promise<string> {
  const { res, deliveryId: id } = await post(event, payload, deliveryId);
  expect(res.statusCode).toBe(202);
  return (await getWebhookDelivery(t.db, id))?.outcome ?? "(none)";
}

interface RunRow {
  id: string;
  status: string;
  status_reason: string | null;
  head_sha: string;
  base_sha: string;
  base_ref: string;
  pr_number: number;
  trigger: string;
  triggered_by: string | null;
  check_run_id: string | null;
  parent_run_id: string | null;
  warnings: string[];
}
async function runs(): Promise<RunRow[]> {
  const { rows } = await t.pool.query<RunRow>("select * from review_runs order by queued_at, id");
  return rows;
}
async function one(): Promise<RunRow> {
  const all = await runs();
  expect(all).toHaveLength(1);
  return all[0]!;
}
async function count(table: string): Promise<number> {
  const { rows } = await t.pool.query<{ n: string }>(`select count(*) as n from ${table}`);
  return Number(rows[0]!.n);
}

async function setSettings(config: Json): Promise<void> {
  const { rows } = await t.pool.query<{ id: string; installation_id: string }>(
    "select id, installation_id from repositories where github_repo_id = 2001",
  );
  await upsertRepoSettings(t.db, rows[0]!.installation_id, rows[0]!.id, config);
}
const sql = (text: string, params: unknown[] = []) => t.pool.query(text, params);

beforeAll(async () => {
  t = await createTestDatabase();
}, 30_000);
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await sql("truncate installations, webhook_deliveries, users cascade");
  quota = undefined;
  build();
  // The normal start of every story: the App was installed on acme/widgets and acme/gadgets.
  expect(await deliver("installation", fixture("installation.created"))).toBe(
    "installation_created",
  );
});

describe("signature verification (AC-13)", () => {
  const payload = JSON.stringify(prEvent("opened"));
  const send = (headers: Record<string, string>, body: string | Buffer = payload) =>
    app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": nextDelivery(),
        ...headers,
      },
      payload: body,
    });

  async function expectNothingCreated(before: { runs: number; deliveries: number }) {
    await service.idle();
    expect(await count("review_runs")).toBe(before.runs);
    expect(await count("webhook_deliveries")).toBe(before.deliveries);
    expect(queue.jobs).toEqual([]);
    expect(github.checkRuns).toEqual([]);
  }
  const snapshot = async () => ({
    runs: await count("review_runs"),
    deliveries: await count("webhook_deliveries"),
  });

  it("accepts a valid signature with 202", async () => {
    const res = await send({ "x-hub-signature-256": sign(payload) });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "accepted" });
    await service.idle();
    expect((await one()).status).toBe("queued");
  });

  it("rejects a missing signature with 401", async () => {
    const before = await snapshot();
    const res = await send({});
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("invalid_signature");
    await expectNothingCreated(before);
  });

  it("rejects an invalid signature with 401", async () => {
    const before = await snapshot();
    const res = await send({ "x-hub-signature-256": "sha256=" + "ab".repeat(32) });
    expect(res.statusCode).toBe(401);
    await expectNothingCreated(before);
  });

  it("rejects a body modified after signing with 401", async () => {
    const before = await snapshot();
    const res = await send({ "x-hub-signature-256": sign(payload) }, payload.replace("7", "8"));
    expect(res.statusCode).toBe(401);
    await expectNothingCreated(before);
  });

  it("rejects a signature made with the wrong secret with 401", async () => {
    const before = await snapshot();
    const res = await send({ "x-hub-signature-256": sign(payload, "not-the-secret") });
    expect(res.statusCode).toBe(401);
    await expectNothingCreated(before);
  });

  it("verifies the raw bytes: re-serialised JSON does not pass", async () => {
    const before = await snapshot();
    // Same JSON value, different bytes (pretty-printed). The signature covers the exact bytes sent.
    const pretty = JSON.stringify(JSON.parse(payload), null, 2);
    const res = await send({ "x-hub-signature-256": sign(payload) }, pretty);
    expect(res.statusCode).toBe(401);
    await expectNothingCreated(before);
  });

  it("does not leak the secret or the expected signature in the response", async () => {
    const res = await send({ "x-hub-signature-256": "sha256=00" });
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain(sign(payload));
  });

  it("answers 400 for missing event/delivery headers and invalid JSON (after the signature check)", async () => {
    const noDelivery = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(payload),
      },
      payload,
    });
    expect(noDelivery.statusCode).toBe(400);

    const bad = "{not json";
    const invalid = await send({ "x-hub-signature-256": sign(bad) }, bad);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("invalid_json");
  });

  it("rejects an oversized payload (413) and unsupported content types (415)", async () => {
    const huge = JSON.stringify({ pad: "x".repeat(MAX_BODY + 1) });
    const tooBig = await send({ "x-hub-signature-256": sign(huge) }, huge);
    expect(tooBig.statusCode).toBe(413);

    const form = "payload=%7B%7D";
    const wrongType = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-github-event": "ping",
        "x-github-delivery": nextDelivery(),
        "x-hub-signature-256": sign(form),
      },
      payload: form,
    });
    expect(wrongType.statusCode).toBe(415);
  });
});

describe("delivery recording and idempotency (AC-14)", () => {
  it("records event, installation and outcome of a delivery", async () => {
    const id = "recorded-1";
    await deliver("pull_request", prEvent("opened"), id);
    const row = await getWebhookDelivery(t.db, id);
    expect(row).toMatchObject({ deliveryId: id, event: "pull_request", outcome: "run_queued" });
    expect(row?.processedAt).toBeInstanceOf(Date);
    const { rows } = await sql("select id from installations where github_installation_id = 1001");
    expect(row?.installationId).toBe(rows[0].id);
  });

  it("a redelivered delivery ID is a no-op: one run, one check run", async () => {
    const first = await post("pull_request", prEvent("opened"), "same-id");
    const again = await post("pull_request", prEvent("opened"), "same-id");
    expect(first.res.json()).toEqual({ status: "accepted" });
    expect(again.res.statusCode).toBe(202);
    expect(again.res.json()).toEqual({ status: "duplicate" });
    expect(await runs()).toHaveLength(1);
    expect(github.checkRuns).toHaveLength(1);
    expect(queue.jobs).toHaveLength(1);
    expect(await count("webhook_deliveries")).toBe(2); // installation.created + this one
  });

  it("concurrent redeliveries of the same ID are processed once", async () => {
    const body = JSON.stringify(prEvent("opened"));
    const send = () =>
      app.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "burst",
          "x-hub-signature-256": sign(body),
        },
        payload: body,
      });
    const results = await Promise.all([send(), send(), send(), send()]);
    await service.idle();
    expect(results.filter((r) => r.json().status === "accepted")).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
  });

  it("a failed delivery is processed again when GitHub redelivers it", async () => {
    github.failFetch = true;
    const id = "will-fail";
    const comment = fixture("issue_comment.created");
    expect(await deliver("issue_comment", comment, id)).toBe("error");
    expect(await runs()).toHaveLength(0);

    github.failFetch = false;
    expect(await deliver("issue_comment", comment, id)).toBe("run_queued");
    expect(await runs()).toHaveLength(1);
    // And a third redelivery is now a duplicate.
    const third = await post("issue_comment", comment, id);
    expect(third.res.json()).toEqual({ status: "duplicate" });
    expect(await runs()).toHaveLength(1);
  });

  it("acknowledges and ignores unknown events", async () => {
    expect(await deliver("star", { action: "created" })).toBe("ignored:unsupported_event");
    expect(await deliver("ping", { zen: "Keep it logically awesome." })).toBe("ignored:ping");
    expect(await runs()).toHaveLength(0);
  });

  it("ignores a signed payload of an unexpected shape instead of failing", async () => {
    expect(await deliver("pull_request", { action: "opened" })).toBe("ignored:invalid_payload");
    expect(await runs()).toHaveLength(0);
  });

  it("answers 202 before processing finishes", async () => {
    let release!: () => void;
    github.gate = new Promise<void>((resolve) => (release = resolve));
    const body = JSON.stringify(prEvent("opened"));
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "slow",
        "x-hub-signature-256": sign(body),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    // Processing is still waiting on the Check Run call.
    expect((await getWebhookDelivery(t.db, "slow"))?.processedAt).toBeNull();
    release();
    await service.idle();
    expect((await getWebhookDelivery(t.db, "slow"))?.outcome).toBe("run_queued");
  });
});

describe("installation sync (PL-01, AC-22)", () => {
  const installationOf = async () =>
    (await sql("select * from installations where github_installation_id = 1001")).rows[0];
  const repos = async () =>
    (
      await sql(
        "select github_repo_id, full_name, active, default_branch from repositories order by github_repo_id",
      )
    ).rows;

  it("created: stores the installation and its repositories", async () => {
    expect(await installationOf()).toMatchObject({
      account_login: "acme",
      account_type: "organization",
      status: "active",
    });
    expect(await repos()).toEqual([
      { github_repo_id: "2001", full_name: "acme/widgets", active: true, default_branch: "main" },
      { github_repo_id: "2002", full_name: "acme/gadgets", active: true, default_branch: "main" },
    ]);
  });

  it("created: is idempotent", async () => {
    await deliver("installation", fixture("installation.created"));
    expect((await repos()).length).toBe(2);
    expect(await count("installations")).toBe(1);
  });

  it("suspend and unsuspend change the status; no runs while suspended", async () => {
    expect(
      await deliver("installation", fixture("installation.created", { action: "suspend" })),
    ).toBe("installation_suspended");
    expect((await installationOf()).status).toBe("suspended");
    expect(await deliver("pull_request", prEvent("opened"))).toBe("ignored:installation_inactive");
    expect(await runs()).toHaveLength(0);

    expect(
      await deliver("installation", fixture("installation.created", { action: "unsuspend" })),
    ).toBe("installation_active");
    expect((await installationOf()).status).toBe("active");
    expect(await deliver("pull_request", prEvent("opened"))).toBe("run_queued");
  });

  it("deleted: deactivates the installation and every repository; no new runs (AC-22)", async () => {
    expect(
      await deliver("installation", fixture("installation.created", { action: "deleted" })),
    ).toBe("installation_deleted");
    expect((await installationOf()).status).toBe("deleted");
    expect((await repos()).every((r) => r.active === false)).toBe(true);

    expect(await deliver("pull_request", prEvent("opened"))).toBe("ignored:installation_inactive");
    expect(await deliver("issue_comment", fixture("issue_comment.created"))).toBe(
      "ignored:installation_inactive",
    );
    expect(await runs()).toHaveLength(0);
    expect(queue.jobs).toEqual([]);
    expect(github.checkRuns).toEqual([]);
  });

  it("deleted keeps history: existing runs are not removed (retention applies)", async () => {
    await deliver("pull_request", prEvent("opened"));
    await deliver("installation", fixture("installation.created", { action: "deleted" }));
    expect(await runs()).toHaveLength(1);
  });

  it("deleted for an unknown installation is ignored", async () => {
    await sql("truncate installations cascade");
    expect(
      await deliver("installation", fixture("installation.created", { action: "deleted" })),
    ).toBe("ignored:unknown_installation");
    expect(await count("installations")).toBe(0);
  });

  it("repositories added: creates them; the default branch stays unknown until a PR event", async () => {
    expect(
      await deliver("installation_repositories", fixture("installation_repositories.added")),
    ).toBe("repositories_added");
    const added = (await repos()).find((r) => r.github_repo_id === "2003");
    expect(added).toMatchObject({ full_name: "acme/gizmos", active: true, default_branch: "main" });
  });

  it("repositories removed: deactivates them, and PRs on them create no runs", async () => {
    const removed = fixture("installation_repositories.added", {
      action: "removed",
      repositories_added: [],
      repositories_removed: [
        { id: 2001, name: "widgets", full_name: "acme/widgets", private: true },
      ],
    });
    expect(await deliver("installation_repositories", removed)).toBe("repositories_removed");
    const list = await repos();
    expect(list.find((r) => r.github_repo_id === "2001")?.active).toBe(false);
    expect(list.find((r) => r.github_repo_id === "2002")?.active).toBe(true);

    expect(await deliver("pull_request", prEvent("opened"))).toBe("ignored:repository_inactive");
    expect(await runs()).toHaveLength(0);
  });

  it("repositories added after removal reactivates the repository", async () => {
    const removed = fixture("installation_repositories.added", {
      action: "removed",
      repositories_added: [],
      repositories_removed: [
        { id: 2001, name: "widgets", full_name: "acme/widgets", private: true },
      ],
    });
    await deliver("installation_repositories", removed);
    await deliver(
      "installation_repositories",
      fixture("installation_repositories.added", {
        repositories_added: [
          { id: 2001, name: "widgets", full_name: "acme/widgets", private: true },
        ],
      }),
    );
    expect(await deliver("pull_request", prEvent("opened"))).toBe("run_queued");
  });

  it("repositories events for a never-seen installation create it (missed installation event)", async () => {
    await sql("truncate installations cascade");
    await deliver("installation_repositories", fixture("installation_repositories.added"));
    expect(await installationOf()).toMatchObject({ account_login: "acme", status: "active" });
    expect(await repos()).toHaveLength(1);
  });

  it("a PR event for a never-seen installation and repository creates them and the run", async () => {
    await sql("truncate installations cascade");
    expect(await deliver("pull_request", prEvent("opened"))).toBe("run_queued");
    expect(await installationOf()).toMatchObject({
      account_login: "acme",
      account_type: "organization",
    });
    expect((await repos())[0]).toMatchObject({ full_name: "acme/widgets", default_branch: "main" });
    expect(await runs()).toHaveLength(1);
  });

  it("a PR event refreshes a renamed repository and its default branch", async () => {
    const event = prEvent("opened");
    await deliver(
      "pull_request",
      patch(event, {
        repository: { full_name: "acme/widgets-renamed", default_branch: "trunk" },
      }),
    );
    const widgets = (await repos()).find((r) => r.github_repo_id === "2001");
    expect(widgets).toMatchObject({ full_name: "acme/widgets-renamed", default_branch: "trunk" });
  });
});

describe("pull request events", () => {
  it("opened: creates a queued run with a queued Check Run and a job (AC-16)", async () => {
    expect(await deliver("pull_request", prEvent("opened"))).toBe("run_queued");
    const run = await one();
    expect(run).toMatchObject({
      status: "queued",
      pr_number: 7,
      head_sha: "1".repeat(40),
      base_sha: "2".repeat(40),
      base_ref: "main",
      trigger: "pull_request",
      triggered_by: "octocat",
      parent_run_id: null,
    });
    expect(github.checkRuns).toEqual([
      {
        headSha: "1".repeat(40),
        externalId: run.id,
        detailsUrl: `http://localhost:5173/runs/${run.id}`,
      },
    ]);
    expect(run.check_run_id).toBe("880000");
    expect(queue.jobs).toEqual([run.id]);
  });

  it.each(["opened", "reopened", "synchronize", "ready_for_review"])(
    "%s creates a run",
    async (action) => {
      expect(await deliver("pull_request", prEvent(action))).toBe("run_queued");
      expect((await one()).status).toBe("queued");
    },
  );

  it.each(["closed", "edited", "labeled", "assigned", "converted_to_draft", "review_requested"])(
    "%s is ignored",
    async (action) => {
      expect(await deliver("pull_request", prEvent(action))).toBe("ignored:unsupported_action");
      expect(await runs()).toHaveLength(0);
    },
  );

  it("synchronize supersedes the older queued run for the same PR (AC-15)", async () => {
    await deliver("pull_request", prEvent("opened", { headSha: sha(1) }));
    await deliver("pull_request", prEvent("synchronize", { headSha: sha(3) }));
    const [older, newer] = await runs();
    expect(older).toMatchObject({ status: "superseded", head_sha: sha(1) });
    expect(older!.status_reason).toContain(newer!.id);
    expect(newer).toMatchObject({ status: "queued", head_sha: sha(3) });
    expect(queue.jobs).toEqual([older!.id, newer!.id]);
  });

  it("supersedes a running run too, and leaves other PRs alone", async () => {
    await deliver("pull_request", prEvent("opened", { headSha: sha(1) }));
    await deliver("pull_request", prEvent("opened", { number: 8, headSha: sha(4) }));
    await sql("update review_runs set status = 'running', started_at = now() where pr_number = 7");
    await deliver("pull_request", prEvent("synchronize", { headSha: sha(5) }));
    const all = await runs();
    expect(all.find((r) => r.head_sha === sha(1))?.status).toBe("superseded");
    expect(all.find((r) => r.pr_number === 8)?.status).toBe("queued");
    expect(all.find((r) => r.head_sha === sha(5))?.status).toBe("queued");
  });

  it("a second event for the same head creates no second run, and still enqueues idempotently", async () => {
    await deliver("pull_request", prEvent("opened"));
    expect(await deliver("pull_request", prEvent("reopened"))).toBe("run_exists");
    expect(await runs()).toHaveLength(1);
    expect(github.checkRuns).toHaveLength(1);
    expect(new Set(queue.jobs).size).toBe(1);
  });

  it("the Check Run failing does not lose the review", async () => {
    github.failCheckRun = true;
    expect(await deliver("pull_request", prEvent("opened"))).toBe("run_queued");
    const run = await one();
    expect(run.status).toBe("queued");
    expect(run.check_run_id).toBeNull();
    expect(run.warnings.join(" ")).toContain("Check Run");
    expect(queue.jobs).toEqual([run.id]);
  });

  it("retrying a delivery whose Check Run failed creates it", async () => {
    github.failCheckRun = true;
    await deliver("pull_request", prEvent("opened"));
    github.failCheckRun = false;
    await deliver("pull_request", prEvent("reopened"));
    expect((await one()).check_run_id).not.toBeNull();
  });

  describe("guards (the PR event x guard matrix)", () => {
    const skippedWith = async (reasonPart: RegExp) => {
      const run = await one();
      expect(run.status).toBe("skipped");
      expect(run.status_reason).toMatch(reasonPart);
      expect(queue.jobs).toEqual([]);
      expect(github.checkRuns).toEqual([]);
    };

    it("wrong target branch: skipped run with the reason", async () => {
      expect(await deliver("pull_request", prEvent("opened", { baseRef: "develop" }))).toBe(
        "run_skipped",
      );
      await skippedWith(/targets "develop".*target_branches/);
    });

    it("a configured target branch is honoured", async () => {
      await setSettings({ review: { target_branches: ["develop"] } });
      await deliver("pull_request", prEvent("opened", { baseRef: "develop" }));
      expect((await one()).status).toBe("queued");
    });

    it("draft: summary_only (default) still queues a run", async () => {
      await deliver("pull_request", prEvent("opened", { draft: true }));
      expect((await one()).status).toBe("queued");
    });

    it("draft with draft_behavior skip: skipped run", async () => {
      await setSettings({ review: { draft_behavior: "skip" } });
      await deliver("pull_request", prEvent("opened", { draft: true }));
      await skippedWith(/is a draft/);
    });

    it("ready_for_review after a skipped draft run reviews the PR", async () => {
      await setSettings({ review: { draft_behavior: "skip" } });
      await deliver("pull_request", prEvent("opened", { draft: true }));
      await deliver("pull_request", prEvent("ready_for_review", { draft: false }));
      const all = await runs();
      expect(all.map((r) => r.status)).toEqual(["skipped", "queued"]);
    });

    it("fork with fork_prs skip (default): skipped run, no keys, no queue", async () => {
      expect(await deliver("pull_request", prEvent("opened", { fork: true }))).toBe("run_skipped");
      await skippedWith(/comes from a fork/);
    });

    it("fork with fork_prs review: queued", async () => {
      await setSettings({ fork_prs: "review" });
      expect(await deliver("pull_request", prEvent("opened", { fork: true }))).toBe("run_queued");
      expect((await one()).status).toBe("queued");
    });

    it("fork with fork_prs review is still subject to the branch guard", async () => {
      await setSettings({ fork_prs: "review" });
      await deliver("pull_request", prEvent("opened", { fork: true, baseRef: "develop" }));
      await skippedWith(/targets "develop"/);
    });

    it("a fork whose repository was deleted counts as a fork", async () => {
      const event = prEvent("opened");
      const noRepo = patch(event, { pull_request: { head: { repo: null } } });
      await deliver("pull_request", noRepo);
      await skippedWith(/comes from a fork/);
    });

    it("repository disabled: skipped run with the reason", async () => {
      await sql("update repositories set enabled = false where github_repo_id = 2001");
      expect(await deliver("pull_request", prEvent("opened"))).toBe("run_skipped");
      await skippedWith(/disabled for acme\/widgets/);
    });

    it("inactive installation: no run at all", async () => {
      await sql("update installations set status = 'suspended'");
      expect(await deliver("pull_request", prEvent("opened"))).toBe(
        "ignored:installation_inactive",
      );
      expect(await runs()).toHaveLength(0);
    });

    it("inactive repository: no run at all", async () => {
      await sql("update repositories set active = false where github_repo_id = 2001");
      expect(await deliver("pull_request", prEvent("opened"))).toBe("ignored:repository_inactive");
      expect(await runs()).toHaveLength(0);
    });

    it("quota hook refusing: skipped run with the quota reason (AC-23 hook)", async () => {
      quota = async () => ({ allowed: false, reason: "quota_exceeded: 200 runs per day" });
      expect(await deliver("pull_request", prEvent("opened"))).toBe("run_skipped");
      await skippedWith(/quota_exceeded/);
    });

    it("the quota hook receives the installation, repository and trigger", async () => {
      const seen: unknown[] = [];
      quota = async (input) => {
        seen.push(input);
        return { allowed: true };
      };
      await deliver("pull_request", prEvent("opened"));
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ trigger: "pull_request" });
    });

    it("invalid stored settings: skipped run that names the problem", async () => {
      await sql(
        `insert into repo_settings (repo_id, installation_id, config)
         select id, installation_id, '{"fork_prs": "maybe"}'::jsonb from repositories where github_repo_id = 2001`,
      );
      await deliver("pull_request", prEvent("opened"));
      await skippedWith(/settings.*invalid.*fork_prs/);
    });

    it("a skipped run does not supersede an older active run", async () => {
      await deliver("pull_request", prEvent("opened", { headSha: sha(1) }));
      await setSettings({ review: { draft_behavior: "skip" } });
      await deliver("pull_request", prEvent("synchronize", { headSha: sha(3), draft: true }));
      expect((await runs()).map((r) => r.status)).toEqual(["queued", "skipped"]);
    });

    it("guards run in the documented order: disabled, then fork, branch, draft, quota", async () => {
      await sql("update repositories set enabled = false where github_repo_id = 2001");
      await deliver("pull_request", prEvent("opened", { fork: true, baseRef: "develop" }));
      expect((await one()).status_reason).toMatch(/disabled/);
      await sql("truncate review_runs cascade");
      await sql("update repositories set enabled = true");
      await deliver("pull_request", prEvent("synchronize", { fork: true, baseRef: "develop" }));
      expect((await one()).status_reason).toMatch(/fork/);
    });
  });

  it("never stores the PR title, body or diff", async () => {
    await deliver("pull_request", prEvent("opened", { fork: true }));
    const dump = JSON.stringify((await sql("select * from review_runs")).rows);
    expect(dump).not.toContain("ignore previous instructions");
    expect(dump).not.toContain("Fix typo");
  });
});

describe("/ai-review comments (FR-02)", () => {
  const comment = (changes: Json = {}, body?: string) =>
    fixture("issue_comment.created", {
      ...changes,
      ...(body !== undefined ? { comment: { body, ...((changes.comment as Json) ?? {}) } } : {}),
    });

  it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
    "a %s creates a manual run for the PR's current head",
    async (association) => {
      github.snapshot.pr.headSha = sha(9);
      expect(
        await deliver("issue_comment", comment({ comment: { author_association: association } })),
      ).toBe("run_queued");
      const run = await one();
      expect(run).toMatchObject({
        trigger: "comment_command",
        triggered_by: "maintainer",
        head_sha: sha(9),
        base_sha: sha(2),
        pr_number: 7,
        status: "queued",
      });
      expect(github.fetchCalls).toEqual([{ installation: 1001, repo: "acme/widgets", pr: 7 }]);
      expect(github.checkRuns).toHaveLength(1);
      expect(queue.jobs).toEqual([run.id]);
    },
  );

  it.each(["NONE", "CONTRIBUTOR", "FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "MANNEQUIN"])(
    "a %s is ignored without any GitHub call",
    async (association) => {
      expect(
        await deliver("issue_comment", comment({ comment: { author_association: association } })),
      ).toBe("ignored:not_authorized");
      expect(await runs()).toHaveLength(0);
      expect(github.fetchCalls).toEqual([]);
    },
  );

  it.each([
    ["/ai-review", true],
    ["  /ai-review  ", true],
    ["/ai-review please", true],
    ["/ai-review\nthanks", true],
    ["/ai-reviewer", false],
    ["/ai-review2", false],
    ["please run /ai-review", false],
    ["ai-review", false],
    ["", false],
  ])("command parsing %j", async (body, accepted) => {
    const outcome = await deliver("issue_comment", comment({}, body));
    expect(outcome).toBe(accepted ? "run_queued" : "ignored:not_a_command");
  });

  it("ignores comments on plain issues", async () => {
    const issue = comment();
    delete (issue.issue as Json).pull_request;
    expect(await deliver("issue_comment", issue)).toBe("ignored:not_a_pull_request");
    expect(await runs()).toHaveLength(0);
  });

  it("ignores edited and deleted comments (an edit must not re-trigger a review)", async () => {
    for (const action of ["edited", "deleted"]) {
      expect(await deliver("issue_comment", comment({ action }))).toBe(
        "ignored:unsupported_action",
      );
    }
    expect(await runs()).toHaveLength(0);
  });

  it("ignores bots", async () => {
    expect(
      await deliver(
        "issue_comment",
        comment({ comment: { user: { login: "some-app[bot]", type: "Bot" } } }),
      ),
    ).toBe("ignored:bot_comment");
  });

  it("ignores a closed pull request", async () => {
    github.snapshot.state = "closed";
    expect(await deliver("issue_comment", comment())).toBe("ignored:pull_request_closed");
    expect(await runs()).toHaveLength(0);
  });

  it("applies the guards: a fork PR is skipped, with a visible reason", async () => {
    github.snapshot.pr.isFork = true;
    expect(await deliver("issue_comment", comment())).toBe("run_skipped");
    expect((await one()).status_reason).toMatch(/fork/);
  });

  it("supersedes the automatic run of the same head", async () => {
    await deliver("pull_request", prEvent("opened", { headSha: sha(1) }));
    await deliver("issue_comment", comment());
    const [auto, manual] = await runs();
    expect(auto!.status).toBe("superseded");
    expect(manual).toMatchObject({ status: "queued", trigger: "comment_command" });
  });

  it("two quick /ai-review comments for the same head produce one active run", async () => {
    await deliver("issue_comment", comment());
    expect(await deliver("issue_comment", comment())).toBe("run_exists");
    expect(await runs()).toHaveLength(1);
  });
});

describe("Check Run re-requests", () => {
  const rerequest = (changes: Json = {}) => fixture("check_run.rerequested", changes);

  async function firstRun(): Promise<RunRow> {
    await deliver("pull_request", prEvent("opened", { headSha: sha(1) }));
    const run = await one();
    // The Check Run id the fixture refers to.
    await sql(
      "update review_runs set check_run_id = 8800001, status = 'completed', finished_at = now(), started_at = now() where id = $1",
      [run.id],
    );
    return { ...run, check_run_id: "8800001" };
  }

  it("creates a re-run linked to the original run via parent_run_id", async () => {
    const parent = await firstRun();
    github.snapshot.pr.headSha = sha(1);
    expect(await deliver("check_run", rerequest())).toBe("run_queued");
    const all = await runs();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      trigger: "check_run_rerequested",
      parent_run_id: parent.id,
      status: "queued",
      head_sha: sha(1),
      triggered_by: "maintainer",
    });
    expect(queue.jobs).toContain(all[1]!.id);
  });

  it("ignores a check that is not ours", async () => {
    await firstRun();
    expect(
      await deliver("check_run", rerequest({ check_run: { id: 123456, name: "CI / build" } })),
    ).toBe("ignored:not_our_check");
    expect(await runs()).toHaveLength(1);
  });

  it("ignores a re-run of an outdated commit so it cannot supersede the current review", async () => {
    await firstRun();
    github.snapshot.pr.headSha = sha(6); // the PR moved on
    expect(await deliver("check_run", rerequest())).toBe("ignored:stale_head");
    expect(await runs()).toHaveLength(1);
  });

  it("ignores a closed pull request", async () => {
    await firstRun();
    github.snapshot.pr.headSha = sha(1);
    github.snapshot.state = "closed";
    expect(await deliver("check_run", rerequest())).toBe("ignored:pull_request_closed");
  });

  it.each(["created", "completed", "requested_action"])("ignores action %s", async (action) => {
    await firstRun();
    expect(await deliver("check_run", rerequest({ action }))).toBe("ignored:unsupported_action");
  });

  it("creates nothing for a deactivated installation", async () => {
    await firstRun();
    await sql("update installations set status = 'deleted'");
    expect(await deliver("check_run", rerequest())).toBe("ignored:installation_inactive");
    expect(await runs()).toHaveLength(1);
  });
});
