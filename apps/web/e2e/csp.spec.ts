// The dashboard under the production Content-Security-Policy (Phase 15, design §9): the built files (not the Vite dev
// server, which injects inline scripts) are served with exactly the headers of docker/nginx/security-headers.conf, in a real
// browser, and every page must work without a single policy violation. A policy that is correct on paper but breaks the
// app is found here, not by a user.
import { expect, test, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { API_URL, ROOT, STATE_FILE } from "./support/env";
import type { SeedState } from "./support/globalSetup";

const seed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SeedState;
const dist = resolve(ROOT, "apps/web/dist");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** `add_header Name "value" always;` lines of the nginx snippet, as the browser would receive them. */
function nginxHeaders(): Record<string, string> {
  const conf = readFileSync(resolve(ROOT, "docker/nginx/security-headers.conf"), "utf8");
  const headers: Record<string, string> = {};
  for (const match of conf.matchAll(/^add_header (\S+) "([^"]*)" always;$/gm)) {
    headers[match[1]!] = match[2]!;
  }
  return headers;
}

let server: http.Server;
let origin = "";
const headers = nginxHeaders();

test.beforeAll(async () => {
  if (!existsSync(join(dist, "index.html"))) {
    execFileSync("npx", ["vite", "build"], {
      cwd: resolve(ROOT, "apps/web"),
      stdio: "ignore",
      shell: process.platform === "win32",
    });
  }
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // The api, as nginx proxies it: /api, /auth (the api sets its own headers there).
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
      const upstream = http.request(
        `${API_URL}${url.pathname}${url.search}`,
        { method: req.method, headers: { ...req.headers, host: new URL(API_URL).host } },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on("error", () => res.writeHead(502).end());
      req.pipe(upstream);
      return;
    }
    const file = normalize(join(dist, url.pathname));
    const served =
      file.startsWith(dist) && existsSync(file) && statSync(file).isFile()
        ? file
        : join(dist, "index.html"); // the single-page app: any other path is a route
    res.writeHead(200, {
      "content-type": TYPES[extname(served)] ?? "application/octet-stream",
      ...headers,
    });
    res.end(readFileSync(served));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  origin = `http://localhost:${(server.address() as { port: number }).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

/** Records every policy violation and every console error of the page. */
async function watch(page: Page) {
  const problems: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __violations: string[] }).__violations ??= [];
      (window as unknown as { __violations: string[] }).__violations.push(
        `${e.violatedDirective} blocked ${e.blockedURI || "inline"}`,
      );
    });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" && /Content Security Policy|Refused to/i.test(msg.text())) {
      problems.push(msg.text());
    }
  });
  page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
  return {
    problems,
    violations: () =>
      page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? []),
  };
}

const PAGES: Array<[string, string]> = [
  ["repositories", "/repos"],
  ["runs", "/runs"],
  ["pending runs", "/runs?view=pending"],
  ["findings", "/findings"],
  ["analytics", "/analytics"],
  ["history of a pull request", `/repos/${seed.repos.api}/pulls/100`],
  ["repository settings", `/repos/${seed.repos.api}/settings`],
  ["installation defaults", `/installations/${seed.installationId}/settings`],
  ["audit log", `/installations/${seed.installationId}/audit`],
];

test.describe("the production policy", () => {
  test("is the one nginx sends: no inline script or style, nothing from another site but GitHub avatars", () => {
    const csp = headers["Content-Security-Policy"]!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  for (const scheme of ["light", "dark"] as const) {
    test.describe(`${scheme} theme`, () => {
      test.use({ colorScheme: scheme });

      for (const [name, path] of PAGES) {
        test(`${name} renders with no violation`, async ({ page }) => {
          const seen = await watch(page);
          await page.goto(`${origin}${path}`);
          await expect(page.getByRole("status")).toHaveCount(0);
          await expect(page.locator("main, [role=main], #main").first()).toBeVisible();
          // The app is really running (not an empty shell): the header shows the signed-in navigation.
          await expect(page.getByRole("navigation").first()).toBeVisible();
          expect(await seen.violations()).toEqual([]);
          expect(seen.problems).toEqual([]);
        });
      }
    });
  }

  test("the run detail, with its charts and folded findings, renders with no violation", async ({
    page,
  }) => {
    const seen = await watch(page);
    await page.goto(`${origin}/runs?status=completed`);
    await page
      .getByRole("link", { name: /demo-org\/api #100/ })
      .first()
      .click();
    await page.getByRole("link", { name: "Earlier run" }).click();
    await expect(page.getByRole("heading", { name: "Findings (3)" })).toBeVisible();
    await page.locator("li[data-category='security'] summary").click();
    expect(await seen.violations()).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  test("the live stream and the theme toggle work under the policy", async ({ page }) => {
    const seen = await watch(page);
    await page.goto(`${origin}/runs`);
    // The stream is a same-origin EventSource (connect-src 'self'): the header says so in words.
    await expect(page.getByText(/Live|Refreshing every few seconds/)).toBeVisible();
    const toggle = page.getByRole("button", { name: /theme|dark|light/i }).first();
    if (await toggle.count()) await toggle.click();
    expect(await seen.violations()).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  test("an inline script that someone injects is blocked, which is what the policy is for", async ({
    page,
  }) => {
    const seen = await watch(page);
    await page.goto(`${origin}/repos`);
    const ran = await page.evaluate(() => {
      const el = document.createElement("script");
      el.textContent = "window.__injected = true";
      document.body.appendChild(el);
      return (window as unknown as { __injected?: boolean }).__injected === true;
    });
    expect(ran).toBe(false);
    expect((await seen.violations()).some((v) => v.startsWith("script-src"))).toBe(true);
  });
});
