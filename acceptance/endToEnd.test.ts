// The Phase 16 end-to-end story, as one test against real PostgreSQL, the real api routes, the real worker
// processor and the real publisher, with only the outside world faked (GitHub, the AI provider):
//
//   install the App -> add a provider key -> open a PR -> it shows as pending -> the worker reviews it -> the review,
//   summary and Check Run reach the PR -> the dashboard history shows it -> feedback -> analytics change -> re-run
//   -> the second review adds no duplicate comments.
//
// The same story runs against a real sandbox repository by hand (docs/pilot.md, "Sandbox check"); this is the part
// of it that CI can run on every change (AC-1 to AC-4, AC-10, AC-16, AC-17, AC-19, AC-21).
import {
  createFakeGitHub,
  createFakePublisherGitHub,
  file,
  type FakePublisherGitHub,
} from "@ai-pr-review/core/testing";
import { getInstallationByGitHubId } from "@ai-pr-review/db/system";
import { getRunById } from "@ai-pr-review/db/system";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type Session } from "../apps/api/src/testing/harness";
import { fixture, prEvent, sha } from "../apps/api/src/webhooks/testing";
import { APP_LOGIN, bugAnswer, buildRig, realPublisher } from "../apps/worker/src/testing";

const HEAD = sha(1);
const PR = 7;
const API_KEY = "sk-acceptance-key-0123456789abcdef";

let h: Harness;
let dana: Session;
let installationId: string;
let repoId: string;
let github: FakePublisherGitHub;

beforeAll(async () => {
  // The api's clock is the harness's, and starts days before the real one that stamps the rows; the story moves it
  // forward to see the analytics, so the session must outlive that.
  h = await createHarness({
    webhooks: {},
    config: { sessionIdleMs: 30 * 24 * 3_600_000, sessionAbsoluteMs: 60 * 24 * 3_600_000 },
  });
  h.gateway.snapshot = {
    pr: { number: PR, baseRef: "main", headSha: HEAD, isDraft: false, isFork: false },
    baseSha: sha(2),
    state: "open",
  };
  github = createFakePublisherGitHub({ headSha: HEAD, appLogin: APP_LOGIN });
}, 60_000);
afterAll(async () => {
  await h.close();
});

const get = (url: string) => h.request(dana, "GET", url);
const post = (url: string, body?: unknown) => h.request(dana, "POST", url, { body });

/**
 * The worker, wired to the same database and keyring the api used, publishing to the in-memory GitHub. What it reads
 * from the pull request is what the earlier reviews left there, as it would be on GitHub.
 */
const worker = () =>
  buildRig(h.t, {
    replies: [bugAnswer("Off-by-one in add")],
    github: (() => {
      const fake = createFakeGitHub({
        files: [file("src/a.ts")],
        pull: { headSha: HEAD, baseRepo: "acme/widgets" },
        issueComments: github.state.issueComments.map(({ id, body }) => ({ id, body })),
        reviewComments: github.state.reviews.flatMap((r) =>
          r.comments.map(({ id, body, path }) => ({ id, body, path })),
        ),
      });
      return {
        calls: fake.calls,
        client: fake.client,
        access: { getClient: async () => fake.client },
      };
    })(),
    deps: { publisher: realPublisher(h.t, github), appLogin: APP_LOGIN, keyring: h.keyring },
  });

/** What the api's queue and the Check Run created for it hold, so the in-memory GitHub knows the Check Run. */
async function registerQueuedCheckRun(runId: string): Promise<void> {
  const stored = await getRunById(h.t.db, runId);
  expect(stored?.checkRunId, "the api created a queued Check Run").toBeTruthy();
  github.state.checkRuns.push({ id: Number(stored!.checkRunId), status: "queued" });
}

describe("install -> key -> PR -> review -> history -> feedback -> re-run", () => {
  it("installing the App creates the installation and its repositories (AC-22 in reverse)", async () => {
    const res = await h.postWebhook("installation", fixture("installation.created"));
    expect(res.statusCode).toBe(202);
    await h.webhookService!.idle();

    const installation = await getInstallationByGitHubId(h.t.db, 1001);
    expect(installation).toMatchObject({ accountLogin: "acme" });
    installationId = installation!.id;

    h.github.users.set("dana", {
      id: 4242,
      login: "dana",
      installations: [
        {
          id: 1001,
          accountLogin: "acme",
          accountType: "organization",
          orgRole: "admin",
          repos: [
            { id: 2001, fullName: "acme/widgets", admin: true },
            { id: 2002, fullName: "acme/gadgets", admin: true },
          ],
        },
      ],
    });
    // What GitHub says when the api refreshes the access cache later (the story moves the clock past its lifetime).
    h.github.orgRoles.set("dana|acme", "admin");
    h.github.repoPermissions.set("dana|acme/widgets", "admin");
    h.github.repoPermissions.set("dana|acme/gadgets", "admin");
    dana = await h.signIn("dana");

    const repos = (await get("/api/repos")).json();
    expect(repos.items.map((r: { full_name: string }) => r.full_name).sort()).toEqual([
      "acme/gadgets",
      "acme/widgets",
    ]);
    repoId = repos.items.find((r: { full_name: string }) => r.full_name === "acme/widgets").id;
  });

  it("an admin adds a provider key and chooses the model; the key is never shown again (AC-18)", async () => {
    const put = await h.request(dana, "PUT", `/api/installations/${installationId}/credentials`, {
      body: { provider: "deepseek", api_key: API_KEY },
    });
    expect(put.statusCode, put.body).toBeLessThan(300);
    expect(put.body).not.toContain(API_KEY);

    const patch = await h.request(dana, "PATCH", `/api/installations/${installationId}/settings`, {
      body: {
        config: {
          provider: "deepseek",
          model: "test-model",
          // One agent and one model call keep the story readable; the other agents have acceptance tests of their own.
          agents: { test_coverage: false, security: false },
        },
      },
    });
    expect(patch.statusCode, patch.body).toBe(200);

    const listed = await get(`/api/installations/${installationId}/credentials`);
    expect(listed.body).not.toContain(API_KEY);
    expect(listed.json().items?.[0] ?? listed.json()).toBeTruthy();
  });

  let runId: string;

  it("a new PR is a queued run with a queued Check Run, visible as pending at once (AC-1, AC-16)", async () => {
    const res = await h.postWebhook(
      "pull_request",
      prEvent("opened", { headSha: HEAD, number: PR }),
    );
    expect(res.statusCode).toBe(202);
    await h.webhookService!.idle();

    const runs = (await get("/api/runs")).json();
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({
      status: "queued",
      pr_number: PR,
      head_sha: HEAD,
      trigger: "pull_request",
    });
    runId = runs.items[0].id;
    expect(h.queue.jobs).toEqual([runId]);
    expect(h.gateway.checkRuns).toHaveLength(1);
    expect(h.signals.updated.map((e) => e.runId)).toContain(runId);

    // The same delivery again, or the same event under a new delivery id, creates no second run (AC-1, AC-14).
    await h.postWebhook("pull_request", prEvent("opened", { headSha: HEAD, number: PR }));
    await h.webhookService!.idle();
    expect((await get("/api/runs")).json().items).toHaveLength(1);
  });

  it("the worker reviews it: one inline comment, one summary, the Check Run completed (AC-2, AC-3)", async () => {
    await registerQueuedCheckRun(runId);
    const outcome = await worker().processor.process(runId);
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });

    expect(github.state.reviews).toHaveLength(1);
    expect(github.state.reviews[0]!.comments).toHaveLength(1);
    expect(github.state.reviews[0]!.comments[0]!.body).toContain("Off-by-one in add");
    expect(github.state.issueComments).toHaveLength(1);
    expect(github.state.checkRuns[0]).toMatchObject({ status: "completed", conclusion: "success" });
  });

  let findingId: string;

  it("the dashboard history shows the finished run with its finding (UI-04, UI-05)", async () => {
    const detail = (await get(`/api/runs/${runId}`)).json();
    expect(detail).toMatchObject({ status: "completed", pr_number: PR });
    expect(detail.findings).toHaveLength(1);
    expect(detail.findings[0]).toMatchObject({ title: "Off-by-one in add", posted: true });
    findingId = detail.findings[0].id;

    const history = (await get(`/api/repos/${repoId}/pulls/${PR}/history`)).json();
    expect(JSON.stringify(history)).toContain(runId);

    const list = (await get("/api/runs?status=completed")).json();
    expect(list.items.map((r: { id: string }) => r.id)).toEqual([runId]);
  });

  it("feedback is stored and moves the analytics (AC-19)", async () => {
    // Analytics cover the last 30 days up to the api's clock, which the harness controls.
    h.clock.advance(7 * 24 * 3_600_000);
    const before = (await get("/api/analytics/summary")).json();
    expect(before.feedback.votes).toBe(0);

    const voted = await post(`/api/findings/${findingId}/feedback`, { verdict: "useful" });
    expect(voted.statusCode, voted.body).toBe(200);

    const after = (await get("/api/analytics/summary")).json();
    expect(after.feedback).toMatchObject({ votes: 1, useful: 1, actionable_rate: 1 });
    expect(after.reviews.completed).toBe(1);
    expect(after.completion).toMatchObject({ rate: 1, sample: 1 });
  });

  it("a re-run is a new run linked to the old one, and the second review adds no duplicate (AC-10, AC-21)", async () => {
    h.queue.jobs.length = 0;
    const res = await post(`/api/runs/${runId}/rerun`);
    expect(res.statusCode, res.body).toBe(202);
    const second = res.json().run;
    expect(second).toMatchObject({ status: "queued", parent_run_id: runId, head_sha: HEAD });
    expect(second.id).not.toBe(runId);

    await registerQueuedCheckRun(second.id);
    const outcome = await worker().processor.process(second.id);
    expect(outcome).toMatchObject({ kind: "finished", status: "completed" });

    // Same commit, same finding: nothing new on the pull request. The summary was updated where it stands.
    expect(github.state.reviews).toHaveLength(1);
    expect(github.state.issueComments).toHaveLength(1);

    const history = (await get(`/api/repos/${repoId}/pulls/${PR}/history`)).json();
    const text = JSON.stringify(history);
    expect(text).toContain(runId);
    expect(text).toContain(second.id);
  });
});
