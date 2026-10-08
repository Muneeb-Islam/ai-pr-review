// Checks that the dashboard serves what is in the database (docs/operations.md, "Restore" and "Upgrade"): after a restore
// or an upgrade, signs in a throwaway user who can see one installation and asks the running stack, through the web
// address a person would use, for the user, the repositories and the runs. The user is removed afterwards.
//
//   node scripts/ops/dashboard-check.mjs --url http://localhost:8080 [--secrets ./secrets]
//
// It needs `docker compose` (to reach the database as the owner) and the stack's secrets directory (to sign the
// session cookie the way the api does). It signs in nobody else and changes nothing but the throwaway user.
import { createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const base = option("url", "http://localhost:8080").replace(/\/+$/, "");
const secrets = option("secrets", "secrets");
const composeFile = process.env.COMPOSE_FILE ?? "docker-compose.prod.yml";
const envFile = process.env.COMPOSE_ENV_FILE;

const sessionSecret = readFileSync(join(secrets, "session_secret"), "utf8").trim();

function sql(statement) {
  return execFileSync(
    "docker",
    [
      "compose",
      "-f",
      composeFile,
      ...(envFile ? ["--env-file", envFile] : []),
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "aipr",
      "-d",
      "aipr",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { encoding: "utf8" },
  ).trim();
}

const userId = randomUUID();
const sessionId = randomUUID();
let failed = false;
const check = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failed = true;
};

try {
  // The installation with the most runs: the one a restored dashboard should show first.
  const installation = sql(
    "select i.id from installations i left join review_runs r on r.installation_id = i.id " +
      "where i.status = 'active' group by i.id order by count(r.id) desc limit 1",
  );
  if (!installation) {
    console.log("The database holds no active installation: nothing to check.");
    process.exit(0);
  }
  const expected = {
    repositories: Number(
      sql(`select count(*) from repositories where installation_id = '${installation}' and active`),
    ),
    runs: Number(sql(`select count(*) from review_runs where installation_id = '${installation}'`)),
  };

  sql(
    `insert into users (id, github_user_id, login) values ('${userId}', -${Math.floor(Math.random() * 1e9) + 1}, 'ops-check')`,
  );
  sql(
    `insert into sessions (id, user_id, expires_at, csrf_secret) values ('${sessionId}', '${userId}', now() + interval '10 minutes', 'ops-check')`,
  );
  sql(
    `insert into user_installations (user_id, installation_id, role) values ('${userId}', '${installation}', 'viewer')`,
  );
  sql(
    `insert into user_repositories (user_id, installation_id, repo_id, role) ` +
      `select '${userId}', installation_id, id, 'viewer' from repositories where installation_id = '${installation}' and active`,
  );

  // The cookie the api issues: the session id and its signature, labelled "session".
  const signature = createHmac("sha256", sessionSecret)
    .update(`session\0${sessionId}`)
    .digest("base64url");
  const cookie = `aipr_session=${sessionId}.${signature}`;
  const get = async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { cookie } });
    return { status: res.status, body: res.ok ? await res.json() : undefined };
  };

  const ready = await fetch(`${base}/readyz`);
  check(ready.ok, `GET /readyz answers ${ready.status}`);

  const me = await get("/api/me");
  check(
    me.status === 200 && me.body?.user?.login === "ops-check",
    "GET /api/me answers for the signed-in user",
  );
  check((me.body?.installations?.length ?? 0) === 1, "the user sees the installation");

  const repos = await get("/api/repos");
  check(
    repos.status === 200 && repos.body.items.length === expected.repositories,
    `GET /api/repos lists ${expected.repositories} repositories (database: ${expected.repositories})`,
  );

  const runs = await get(`/api/runs?limit=${Math.min(Math.max(expected.runs, 1), 100)}`);
  check(runs.status === 200, "GET /api/runs answers");
  check(
    (runs.body?.items?.length ?? 0) === Math.min(expected.runs, 100),
    `GET /api/runs lists ${runs.body?.items?.length ?? 0} runs (database: ${expected.runs})`,
  );

  if (expected.runs > 0 && runs.body?.items?.[0]) {
    const detail = await get(`/api/runs/${runs.body.items[0].id}`);
    check(detail.status === 200, "GET /api/runs/:id opens the newest run");
  }
} finally {
  try {
    sql(`delete from users where id = '${userId}'`);
  } catch {
    console.error(`Could not remove the throwaway user ${userId}; delete it by hand.`);
  }
}

console.log(
  failed ? "The dashboard check FAILED." : "The dashboard serves what the database holds.",
);
process.exit(failed ? 1 : 0);
