// The deployment files and the operations documentation stay in step with the code (Phase 15): every environment
// variable is documented, every alert names a metric that exists, the images run unprivileged and hold no secret, the
// compose file passes secrets as files, and the web server sends the security headers the design asks for.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { serverEnvShape } from "./env";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${root}${path}`, "utf8");

/** Variable names that carry a secret (a version number or a plain setting that shares a word with one does not). */
const isSecretName = (name: string): boolean =>
  /SECRET|PASSWORD|PRIVATE_KEY|(^|_)TOKEN(_FILE)?$|ENCRYPTION_KEY|DATABASE_URL|REDIS_URL/.test(
    name,
  ) && !/_VERSION$/.test(name);

/** The metric names in the `expr` of every rule (not in the comments around them). */
const alertMetrics = (): Set<string> => {
  const doc = parse(read("docs/prometheus-alerts.yml")) as {
    groups: Array<{ rules: Array<{ expr: string }> }>;
  };
  return new Set(
    doc.groups.flatMap((g) => g.rules).flatMap((r) => r.expr.match(/aipr_[a-z0-9_]+/g) ?? []),
  );
};

describe("docs/operations.md", () => {
  const doc = read("docs/operations.md");

  it("documents every environment variable the services read", () => {
    const missing = Object.keys(serverEnvShape).filter((name) => !doc.includes(`\`${name}\``));
    expect(missing, "add these to the table in docs/operations.md, section 5").toEqual([]);
  });

  it("documents the variables that only some scripts and the compose file read", () => {
    for (const name of [
      "MIGRATION_DATABASE_URL",
      "MIGRATIONS_FOLDER",
      "TRUST_PROXY",
      "WORKER_LIVENESS_FILE",
      "VERSION",
      "WEB_PORT",
    ]) {
      expect(doc, name).toContain(`\`${name}\``);
    }
  });

  it("names an owner, an escalation path and the runbooks the exit criteria ask for", () => {
    for (const heading of [
      "Ownership, support and escalation",
      "Backup and restore",
      "Recovery runbooks",
      "Upgrade and rollback",
      "Rotating the encryption key",
      "Emergency: revoking keys",
      "The production GitHub App",
    ]) {
      expect(doc, heading).toContain(heading);
    }
    expect(doc).toContain("Escalation path:");
  });

  it("lists every metric the alert rules use in its metrics table", () => {
    for (const name of alertMetrics()) expect(doc, name).toContain("`" + name);
  });
});

describe("docs/prometheus-alerts.yml", () => {
  const exported = new Set(
    [read("apps/api/src/metrics/collect.ts"), read("apps/api/src/metrics/registry.ts")].flatMap(
      (source) => source.match(/"aipr_[a-z0-9_]+"/g) ?? [],
    ),
  );
  const names = new Set([...exported].map((n) => n.replaceAll('"', "")));

  it("is valid YAML with rules that each have an expression, a duration and a summary", () => {
    const doc = parse(read("docs/prometheus-alerts.yml")) as {
      groups: Array<{
        rules: Array<{
          alert: string;
          expr: string;
          for: string;
          annotations: { summary: string };
        }>;
      }>;
    };
    const rules = doc.groups.flatMap((g) => g.rules);
    expect(rules.length).toBeGreaterThanOrEqual(8);
    for (const rule of rules) {
      expect(rule.expr, rule.alert).toBeTruthy();
      expect(rule.for, rule.alert).toMatch(/^\d+[mh]$/);
      expect(rule.annotations.summary, rule.alert).toBeTruthy();
    }
  });

  it("uses only metrics the api exports", () => {
    for (const metric of alertMetrics()) {
      expect(names.has(metric), `${metric} is not exported by apps/api/src/metrics`).toBe(true);
    }
  });

  it("covers the failures the phase asks for: a stuck queue, failure spikes and webhook failures", () => {
    const text = read("docs/prometheus-alerts.yml");
    expect(text).toContain("aipr_oldest_queued_run_age_seconds");
    expect(text).toContain("aipr_run_failure_ratio_24h");
    expect(text).toContain("aipr_webhook_deliveries_24h");
  });
});

describe("docker/Dockerfile", () => {
  const dockerfile = read("docker/Dockerfile");

  it("runs every Node image as the unprivileged user and the web image as nginx-unprivileged", () => {
    expect(dockerfile).toMatch(/FROM runtime AS api/);
    expect(dockerfile).toMatch(/AS runtime\nENV[^\n]*\\?\n?[^\n]*\nWORKDIR \/app\nUSER node/);
    expect(dockerfile).toContain("nginxinc/nginx-unprivileged");
    expect(dockerfile).not.toMatch(/^USER root/m);
  });

  it("is multi-stage: the running images copy built output, never the source or the dev dependencies", () => {
    const stages = [...dockerfile.matchAll(/^FROM .* AS (\w[\w-]*)$/gm)].map((m) => m[1]);
    expect(stages).toEqual(
      expect.arrayContaining(["build", "prod-deps", "api", "worker", "migrate", "web"]),
    );
    expect(dockerfile).toContain("npm ci --omit=dev");
    // Nothing is copied from the whole context into a running image.
    const finalStages = dockerfile.slice(dockerfile.indexOf("FROM runtime AS api"));
    expect(finalStages).not.toMatch(/COPY \. /);
  });

  it("bakes no secret in: no ENV or ARG that carries one, and nothing copies .env or keys", () => {
    for (const line of dockerfile.split("\n").filter((l) => /^\s*(ENV|ARG)\b/.test(l))) {
      expect(isSecretName(line), line).toBe(false);
    }
    for (const line of dockerfile.split("\n").filter((l) => /^\s*(COPY|ADD)\b/.test(l))) {
      expect(line, line).not.toMatch(/\.env|\.pem|secrets/);
    }
    const ignore = read(".dockerignore");
    for (const entry of [".env", "secrets", "*.pem", ".git"]) expect(ignore).toContain(entry);
  });

  it("has a health check for every service that can answer one", () => {
    // api, worker and web; the migration is a one-shot job.
    expect(dockerfile.match(/^HEALTHCHECK/gm)?.length).toBe(3);
  });
});

describe("docker-compose.prod.yml", () => {
  const compose = parse(read("docker-compose.prod.yml")) as {
    services: Record<
      string,
      {
        environment?: Record<string, string>;
        ports?: string[];
        depends_on?: Record<string, unknown>;
        secrets?: string[];
      }
    >;
    secrets: Record<string, { file: string }>;
  };

  it("passes every secret as a file: no secret-looking variable has a literal value", () => {
    for (const [service, def] of Object.entries(compose.services)) {
      for (const [name, value] of Object.entries(def.environment ?? {})) {
        if (!isSecretName(name)) continue;
        expect(name.endsWith("_FILE"), `${service}: ${name} must be a _FILE variable`).toBe(true);
        expect(String(value), `${service}: ${name}`).toMatch(/^\/run\/secrets\//);
      }
    }
  });

  it("every secret file it mounts is declared, kept in ./secrets, and created by init-secrets.sh or supplied by the operator", () => {
    const init = read("scripts/ops/init-secrets.sh");
    const supplied = ["github_app_private_key", "github_client_secret"];
    for (const [name, def] of Object.entries(compose.secrets)) {
      expect(def.file).toBe(`./secrets/${name}`);
      expect(supplied.includes(name) || init.includes(name), name).toBe(true);
    }
    for (const def of Object.values(compose.services)) {
      for (const name of def.secrets ?? []) expect(compose.secrets, name).toHaveProperty(name);
    }
  });

  it("publishes only the web server, and runs migrations before api and worker", () => {
    const published = Object.entries(compose.services)
      .filter(([, def]) => def.ports)
      .map(([name]) => name);
    expect(published).toEqual(["web"]);
    for (const service of ["api", "worker"]) {
      expect(compose.services[service]!.depends_on, service).toMatchObject({
        migrate: { condition: "service_completed_successfully" },
      });
    }
  });

  it("uses a project name of its own, so it can never touch the development stack's containers", () => {
    const text = read("docker-compose.prod.yml");
    expect(text).toMatch(/^name: ai-pr-review-prod$/m);
  });
});

describe(".env.production.example", () => {
  it("holds settings, not secrets", () => {
    const names = read(".env.production.example")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => l.split("=")[0]!);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(isSecretName(name), name).toBe(false);
  });
});

describe("docker/nginx", () => {
  const headers = read("docker/nginx/security-headers.conf");
  const site = read("docker/nginx/default.conf");

  it("sends a CSP with no inline script, no eval and no wildcard, and forbids framing", () => {
    const csp = headers.match(/Content-Security-Policy "([^"]+)"/)![1]!;
    const directives = Object.fromEntries(
      csp.split(";").map((d) => {
        const [name, ...values] = d.trim().split(/\s+/);
        return [name, values];
      }),
    ) as Record<string, string[]>;
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["style-src"]).toEqual(["'self'"]);
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|http:/);
  });

  it("sends HSTS, frame protection, nosniff, a referrer policy and a permissions policy on every response", () => {
    expect(headers).toMatch(/Strict-Transport-Security "max-age=\d{7,}; includeSubDomains"/);
    expect(headers).toContain('X-Frame-Options "DENY"');
    expect(headers).toContain('X-Content-Type-Options "nosniff"');
    expect(headers).toContain('Referrer-Policy "no-referrer"');
    expect(headers).toContain("Permissions-Policy");
    // `always`: also on errors and redirects.
    for (const line of headers.split("\n").filter((l) => l.startsWith("add_header"))) {
      expect(line).toMatch(/always;$/);
    }
  });

  it("includes them in the server and in the locations that serve files, and hides the server version", () => {
    expect(site).toContain("server_tokens off");
    expect(
      site.match(/include \/etc\/nginx\/security-headers\.conf;/g)!.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("does not expose /metrics, trusts X-Forwarded-For only from private ranges, and never forwards a client-supplied one", () => {
    expect(site).toMatch(/location = \/metrics \{\s*return 404;/);
    expect(site).toContain("set_real_ip_from 10.0.0.0/8");
    expect(site).not.toMatch(/set_real_ip_from 0\.0\.0\.0\/0/);
    expect(site).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(site).not.toContain("$proxy_add_x_forwarded_for");
  });

  it("proxies only the api's paths", () => {
    expect(site).toContain("location ~ ^/(api|auth|webhooks)/");
    expect(site).toContain("location ~ ^/(healthz|readyz)$");
    expect(site.match(/proxy_pass/g)).toHaveLength(2);
  });
});

describe("CI workflows", () => {
  const workflows = ["ci.yml"].map((name) => [name, read(`.github/workflows/${name}`)] as const);

  it("pin every third-party action to a full commit, not a movable tag", () => {
    for (const [name, text] of workflows) {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const action of uses) {
        if (action.startsWith("./")) continue;
        expect(action, `${name}: ${action}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      }
    }
  });

  it("run with read-only repository permissions, and audit dependencies for high severity", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^permissions:\n\s+contents: read$/m);
    expect(ci).toContain("npm audit --audit-level=high");
    expect(ci).toContain("npm run test:chaos");
    expect(ci).toContain("scripts/ops/smoke.sh");
  });
});
