import { generateKeyPairSync, verify } from "node:crypto";
import { createLogger } from "@ai-pr-review/shared";
import { describe, expect, it } from "vitest";
import { createAppJwt, GitHubAppAuth, loadPrivateKey, normalizePrivateKey } from "./app-auth";
import { createGitHubGateway } from "./gateway";

const logger = createLogger({ app: "test" }, () => undefined);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("private key handling", () => {
  it("accepts PKCS#8 and PKCS#1 PEM", () => {
    expect(() => loadPrivateKey(pkcs8)).not.toThrow();
    expect(() => loadPrivateKey(pkcs1)).not.toThrow();
  });

  it("accepts a single-line env value with literal backslash-n and quotes", () => {
    const oneLine = `"${pkcs8.trim().replace(/\n/g, "\\n")}"`;
    expect(normalizePrivateKey(oneLine)).toBe(pkcs8.trim());
    expect(() => loadPrivateKey(oneLine)).not.toThrow();
  });

  it("fails with a message that does not contain the key", () => {
    const bad = "-----BEGIN PRIVATE KEY-----\nTOP-SECRET-MATERIAL\n-----END PRIVATE KEY-----";
    expect(() => loadPrivateKey(bad)).toThrow("GITHUB_APP_PRIVATE_KEY is not a valid PEM");
    try {
      loadPrivateKey(bad);
    } catch (err) {
      expect(String(err)).not.toContain("TOP-SECRET-MATERIAL");
    }
  });
});

describe("App JWT", () => {
  const now = Date.UTC(2030, 0, 1, 12, 0, 0);
  const jwt = createAppJwt({ appId: 12345, privateKey: loadPrivateKey(pkcs8) }, now);
  const [header, payload, signature] = jwt.split(".") as [string, string, string];

  it("is an RS256 token for the App with a short lifetime", () => {
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(now / 1000 - 60); // backdated for clock drift
    expect(claims.exp - now / 1000).toBeLessThanOrEqual(10 * 60);
    expect(claims.exp).toBeGreaterThan(now / 1000);
  });

  it("verifies against the App's public key and not against another key", () => {
    const data = Buffer.from(`${header}.${payload}`);
    const sig = Buffer.from(signature, "base64url");
    expect(verify("RSA-SHA256", data, publicKey, sig)).toBe(true);
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(verify("RSA-SHA256", data, other, sig)).toBe(false);
  });
});

/** A fake of GitHub's token endpoint that counts calls and checks it is called with an App JWT. */
function tokenServer(options: { lifetimeMs?: number } = {}) {
  const calls: Array<{ url: string; auth: string | null }> = [];
  let counter = 0;
  const clock = { now: Date.UTC(2030, 0, 1, 12, 0, 0) };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input as string | URL, init);
    calls.push({ url: request.url, auth: request.headers.get("authorization") });
    if (request.url.endsWith("/access_tokens")) {
      counter += 1;
      return Response.json(
        {
          token: `ghs_installationtoken${String(counter).padStart(10, "0")}`,
          expires_at: new Date(clock.now + (options.lifetimeMs ?? 3_600_000)).toISOString(),
        },
        { status: 201 },
      );
    }
    return Response.json({ message: "unexpected" }, { status: 500 });
  };
  return { calls, clock, fetch: fetchImpl, tokenRequests: () => counter };
}

describe("installation tokens", () => {
  const make = (server: ReturnType<typeof tokenServer>) =>
    new GitHubAppAuth(
      { appId: 99, privateKey: pkcs8 },
      { logger, fetch: server.fetch, now: () => server.clock.now },
    );

  it("creates a token with an App JWT and caches it", async () => {
    const server = tokenServer();
    const auth = make(server);
    const first = await auth.getInstallationToken(1);
    const second = await auth.getInstallationToken(1);
    expect(first).toBe(second);
    expect(server.tokenRequests()).toBe(1);
    expect(server.calls[0]!.url).toBe("https://api.github.com/app/installations/1/access_tokens");
    expect(server.calls[0]!.auth).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/i);
  });

  it("keeps a separate token per installation", async () => {
    const server = tokenServer();
    const auth = make(server);
    const a = await auth.getInstallationToken(1);
    const b = await auth.getInstallationToken(2);
    expect(a).not.toBe(b);
    expect(server.tokenRequests()).toBe(2);
  });

  it("refreshes early: not at expiry but once less than 5 minutes remain", async () => {
    const server = tokenServer({ lifetimeMs: 60 * 60 * 1000 });
    const auth = make(server);
    const first = await auth.getInstallationToken(1);

    server.clock.now += 54 * 60 * 1000; // 6 minutes left: still cached
    expect(await auth.getInstallationToken(1)).toBe(first);
    expect(server.tokenRequests()).toBe(1);

    server.clock.now += 2 * 60 * 1000; // 4 minutes left: refresh
    const refreshed = await auth.getInstallationToken(1);
    expect(refreshed).not.toBe(first);
    expect(server.tokenRequests()).toBe(2);
  });

  it("shares one request between concurrent callers", async () => {
    const server = tokenServer();
    const auth = make(server);
    const tokens = await Promise.all([1, 2, 3, 4].map(() => auth.getInstallationToken(7)));
    expect(new Set(tokens).size).toBe(1);
    expect(server.tokenRequests()).toBe(1);
  });

  it("fetches a new token after invalidate()", async () => {
    const server = tokenServer();
    const auth = make(server);
    await auth.getInstallationToken(1);
    auth.invalidate(1);
    await auth.getInstallationToken(1);
    expect(server.tokenRequests()).toBe(2);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const server = tokenServer();
    const flaky: typeof fetch = async (input, init) => {
      if (fail) return Response.json({ message: "Not Found" }, { status: 404 });
      return server.fetch(input, init);
    };
    const auth = new GitHubAppAuth(
      { appId: 99, privateKey: pkcs8 },
      { logger, fetch: flaky, now: () => server.clock.now },
    );
    await expect(auth.getInstallationToken(1)).rejects.toMatchObject({ status: 404 });
    fail = false;
    await expect(auth.getInstallationToken(1)).resolves.toMatch(/^ghs_/);
  });

  it("uses the installation token (not the JWT) for API calls", async () => {
    const server = tokenServer();
    const requests: Array<{ url: string; auth: string | null; body: string }> = [];
    const routed: typeof fetch = async (input, init) => {
      const req = new Request(input as string | URL, init);
      if (req.url.endsWith("/access_tokens")) return server.fetch(input, init);
      requests.push({
        url: req.url,
        auth: req.headers.get("authorization"),
        body: await req.text(),
      });
      if (req.url.endsWith("/check-runs")) return Response.json({ id: 4242 }, { status: 201 });
      return Response.json(
        {
          number: 5,
          state: "open",
          draft: false,
          base: { ref: "main", sha: "b".repeat(40), repo: { full_name: "o/r" } },
          head: { sha: "h".repeat(40), repo: { full_name: "fork/r" } },
        },
        { status: 200 },
      );
    };
    const auth = new GitHubAppAuth(
      { appId: 99, privateKey: pkcs8 },
      { logger, fetch: routed, now: () => server.clock.now },
    );
    const gateway = createGitHubGateway(auth);
    const repo = { owner: "o", repo: "r" };

    const snapshot = await gateway.fetchPullRequest(11, repo, 5);
    expect(snapshot).toEqual({
      pr: { number: 5, baseRef: "main", headSha: "h".repeat(40), isDraft: false, isFork: true },
      baseSha: "b".repeat(40),
      state: "open",
    });

    const checkId = await gateway.createQueuedCheckRun(11, repo, {
      headSha: "h".repeat(40),
      externalId: "run-1",
      detailsUrl: "http://localhost:5173/runs/run-1",
    });
    expect(checkId).toBe(4242);

    const post = requests.find((r) => r.url.endsWith("/check-runs"))!;
    expect(post.auth).toMatch(/^(token|bearer) ghs_/i);
    expect(JSON.parse(post.body)).toMatchObject({
      name: "AI PR Review",
      head_sha: "h".repeat(40),
      status: "queued",
      external_id: "run-1",
    });
    // One token creation served both calls.
    expect(server.tokenRequests()).toBe(1);
  });
});
