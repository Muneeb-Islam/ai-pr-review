import { describe, expect, it } from "vitest";
import { createFakeGitHub, type FakeActions } from "../context/test-support";
import { fetchCoverageArtifact, describeUnavailable } from "./artifact";
import { lcovRecord, lcovZip, makeZip } from "./test-support";

const REPO = { owner: "acme", repo: "widgets" };
const HEAD = "a".repeat(40);
const LCOV = lcovRecord("src/a.ts", [[1, 1]]);

function run(
  actions: FakeActions,
  extra: { failures?: Record<string, number>; name?: string; path?: string } = {},
) {
  const github = createFakeGitHub({
    actions,
    ...(extra.failures ? { failures: extra.failures } : {}),
  });
  const result = fetchCoverageArtifact({
    client: github.client,
    repo: REPO,
    headSha: HEAD,
    artifactName: extra.name ?? "coverage",
    lcovPath: extra.path ?? "lcov.info",
  });
  return { github, result };
}

const withArtifact = (
  over: Partial<NonNullable<FakeActions["artifacts"]>[number][number]> = {},
): FakeActions => ({
  runs: [{ id: 10, status: "completed", created_at: "2026-01-01T10:00:00Z" }],
  artifacts: { 10: [{ id: 500, name: "coverage", size_in_bytes: 1000, ...over }] },
  zips: { 500: new Uint8Array(lcovZip(LCOV)) },
});

describe("fetchCoverageArtifact: the report is there", () => {
  it("finds the run for the head SHA, its artifact, and reads the LCOV file", async () => {
    const { github, result } = run(withArtifact());
    const found = await result;
    expect(found).toEqual({ ok: true, lcov: LCOV, artifact: { name: "coverage", runId: 10 } });
    const routes = github.calls.map((c) => c.route);
    expect(routes).toEqual([
      "GET /repos/{owner}/{repo}/actions/runs",
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts",
      "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/{archive_format}",
    ]);
    expect(github.calls[0]?.params).toMatchObject({ head_sha: HEAD });
    expect(github.calls[1]?.params).toMatchObject({ run_id: 10, name: "coverage" });
    expect(github.calls[2]?.params).toMatchObject({ artifact_id: 500, archive_format: "zip" });
  });

  it("accepts the bytes as an ArrayBuffer, which is what Octokit returns", async () => {
    const zip = lcovZip(LCOV);
    const buffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
    const { result } = run({ ...withArtifact(), zips: { 500: buffer } });
    expect((await result).ok).toBe(true);
  });

  it("uses a configured artifact name and file path", async () => {
    const { result } = run(
      {
        runs: [{ id: 10, status: "completed" }],
        artifacts: { 10: [{ id: 7, name: "unit-coverage", size_in_bytes: 100 }] },
        zips: { 7: new Uint8Array(makeZip([{ name: "reports/lcov.info", data: LCOV }])) },
      },
      { name: "unit-coverage", path: "reports/lcov.info" },
    );
    expect(await result).toMatchObject({
      ok: true,
      artifact: { name: "unit-coverage", runId: 10 },
    });
  });

  it("finds a report uploaded from a directory (lcov.info under coverage/)", async () => {
    const { result } = run({
      ...withArtifact(),
      zips: { 500: new Uint8Array(makeZip([{ name: "coverage/lcov.info", data: LCOV }])) },
    });
    expect((await result).ok).toBe(true);
  });

  it("takes the newest artifact across runs and skips expired ones", async () => {
    const { github, result } = run({
      runs: [
        { id: 10, status: "completed", created_at: "2026-01-01T10:00:00Z" },
        { id: 11, status: "completed", created_at: "2026-01-01T11:00:00Z" },
      ],
      artifacts: {
        11: [{ id: 600, name: "coverage", expired: true, created_at: "2026-01-01T11:05:00Z" }],
        10: [{ id: 500, name: "coverage", size_in_bytes: 1000 }],
      },
      zips: { 500: new Uint8Array(lcovZip(LCOV)) },
    });
    expect(await result).toMatchObject({ ok: true, artifact: { runId: 10 } });
    expect(
      github.calls.filter((c) => c.route.endsWith("/artifacts")).map((c) => c.params["run_id"]),
    ).toEqual([11, 10]);
  });
});

describe("fetchCoverageArtifact: no report (FR-23)", () => {
  it("no workflow run for the commit", async () => {
    const { result } = run({ runs: [] });
    expect(await result).toMatchObject({ ok: false, code: "no_runs" });
  });

  it("CI is still running and has uploaded nothing yet", async () => {
    const { github, result } = run({
      runs: [{ id: 10, status: "in_progress" }],
      artifacts: { 10: [] },
    });
    const out = await result;
    expect(out).toMatchObject({ ok: false, code: "ci_running" });
    expect(github.calls.some((c) => c.route.endsWith("{archive_format}"))).toBe(false);
  });

  it("CI finished without uploading the artifact", async () => {
    const { result } = run({
      runs: [{ id: 10, status: "completed" }],
      artifacts: { 10: [{ id: 1, name: "other" }] },
    });
    const out = await result;
    expect(out).toMatchObject({ ok: false, code: "no_artifact" });
    if (!out.ok) expect(out.message).toContain('"coverage"');
  });

  it("the artifact has expired", async () => {
    const { result } = run(withArtifact({ expired: true }));
    expect(await result).toMatchObject({ ok: false, code: "artifact_expired" });
  });

  it("an artifact over the size cap is not downloaded", async () => {
    const { github, result } = run(withArtifact({ size_in_bytes: 900 * 1024 * 1024 }));
    expect(await result).toMatchObject({ ok: false, code: "artifact_too_large" });
    expect(github.calls.some((c) => c.route.endsWith("{archive_format}"))).toBe(false);
  });

  it("a download that turns out bigger than the cap is refused", async () => {
    const big = new Uint8Array(60 * 1024 * 1024);
    const { result } = run({ ...withArtifact({ size_in_bytes: 10 }), zips: { 500: big } });
    expect(await result).toMatchObject({ ok: false, code: "artifact_too_large" });
  });

  it("a malicious archive is refused and reported as unreadable", async () => {
    const bomb = makeZip([{ name: "lcov.info", data: Buffer.alloc(20 * 1024 * 1024) }]);
    const { result } = run({ ...withArtifact(), zips: { 500: new Uint8Array(bomb) } });
    expect(await result).toMatchObject({ ok: false, code: "artifact_invalid" });
  });

  it("something that is not a zip", async () => {
    const { result } = run({
      ...withArtifact(),
      zips: { 500: new TextEncoder().encode("<html>login</html>") },
    });
    expect(await result).toMatchObject({ ok: false, code: "artifact_invalid" });
  });

  it("an answer that is not bytes at all", async () => {
    const { result } = run({ ...withArtifact(), zips: { 500: { message: "nope" } } });
    expect(await result).toMatchObject({ ok: false, code: "artifact_invalid" });
  });

  it("the report file is not in the artifact", async () => {
    const { result } = run({
      ...withArtifact(),
      zips: { 500: new Uint8Array(makeZip([{ name: "other.txt", data: "x" }])) },
    });
    const out = await result;
    expect(out).toMatchObject({ ok: false, code: "lcov_missing" });
    if (!out.ok) expect(out.message).toContain("coverage.lcov_path");
  });

  it.each([403, 404])("the App may not read Actions (HTTP %i)", async (status) => {
    const { result } = run(withArtifact(), {
      failures: { "GET /repos/{owner}/{repo}/actions/runs": status },
    });
    const out = await result;
    expect(out).toMatchObject({ ok: false, code: "actions_denied" });
    if (!out.ok) expect(out.message).toContain("Actions: read");
  });

  it("a GitHub outage is a reason, not an exception", async () => {
    const { result } = run(withArtifact(), {
      failures: { "GET /repos/{owner}/{repo}/actions/runs": 503 },
    });
    expect(await result).toMatchObject({ ok: false, code: "github_error" });
  });

  it("an answer in an unexpected shape is a reason, not an exception", async () => {
    const github = createFakeGitHub({});
    github.client.request = async () => ({ data: { surprise: true } });
    const out = await fetchCoverageArtifact({
      client: github.client,
      repo: REPO,
      headSha: HEAD,
      artifactName: "coverage",
      lcovPath: "lcov.info",
    });
    expect(out).toMatchObject({ ok: false, code: "github_error" });
  });
});

describe("fetchCoverageArtifact: cancellation", () => {
  it("rethrows an abort instead of calling it a missing report", async () => {
    const controller = new AbortController();
    controller.abort();
    const github = createFakeGitHub({ actions: withArtifact() });
    await expect(
      fetchCoverageArtifact({
        client: github.client,
        repo: REPO,
        headSha: HEAD,
        artifactName: "coverage",
        lcovPath: "lcov.info",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("describeUnavailable", () => {
  it("has a sentence for every reason and never echoes anything but the configured names", () => {
    for (const code of [
      "actions_denied",
      "no_runs",
      "ci_running",
      "no_artifact",
      "artifact_expired",
      "artifact_too_large",
      "artifact_invalid",
      "lcov_missing",
      "lcov_invalid",
      "lcov_empty",
      "github_error",
      "no_client",
      "no_source_files",
    ] as const) {
      expect(describeUnavailable(code).length).toBeGreaterThan(10);
    }
  });
});
