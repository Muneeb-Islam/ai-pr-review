import type { Finding } from "@ai-pr-review/shared";
import { parsePatch } from "../context/diff";
import { redactSecrets } from "../context/redact";
import type { ChangedFile } from "../context/types";
import { fingerprintFinding } from "../validation/fingerprint";

// Dependency review (Phase 12): what a pull request changes in `package.json`, found by code, not by the model.
// Lockfiles never reach the Security agent (Phase 5 excludes them), so the manifest is the whole picture. Two
// products come out of it: a plain-text section for the prompt (what was added, changed or given an install
// script) and a few findings for the rules that need no judgement: an install script, a dependency fetched from
// git or a URL without a pinned commit, a name one letter away from a popular package. The model is told which
// of these the platform already reported and adds what rules cannot see (a suspicious package, a risky upgrade).

export type DependencySection =
  "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies";

export interface DependencyChange {
  path: string;
  name: string;
  section: DependencySection | "unknown";
  /** The spec before the change; absent for a new dependency. */
  from?: string;
  to: string;
  /** New-file line number of the added line. */
  line: number;
  /** The added line as written, redacted. */
  text: string;
}

export interface ScriptChange {
  path: string;
  name: string;
  from?: string;
  to: string;
  line: number;
  text: string;
}

export interface ManifestChanges {
  dependencies: DependencyChange[];
  scripts: ScriptChange[];
  /** Dependencies the change removed, for the prompt only. */
  removed: Array<{ path: string; name: string }>;
}

/** Scripts that run on the machine of whoever installs the package. */
export const INSTALL_SCRIPTS: ReadonlySet<string> = new Set([
  "preinstall",
  "install",
  "postinstall",
]);

const DEPENDENCY_SECTIONS: ReadonlySet<string> = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);
/** Objects whose entries are not dependencies, so nothing inside them is read as one. */
const OTHER_SECTIONS: ReadonlySet<string> = new Set([
  "engines",
  "repository",
  "bugs",
  "funding",
  "publishConfig",
  "directories",
  "config",
  "exports",
  "imports",
  "browser",
  "bin",
  "man",
  "peerDependenciesMeta",
  "dependenciesMeta",
  "volta",
  "overrides",
  "resolutions",
  "pnpm",
  "jest",
  "eslintConfig",
  "prettier",
  "lint-staged",
]);
/** Top-level fields whose value can look like a version but is not a dependency. */
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "name",
  "version",
  "description",
  "main",
  "module",
  "types",
  "type",
  "license",
  "author",
  "homepage",
  "packageManager",
  "node",
  "npm",
  "pnpm",
  "yarn",
]);

const SECTION_OPEN = /^(\s*)"([^"]+)"\s*:\s*\{\s*$/;
const ENTRY = /^\s*"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/;

/** A string that can only be a dependency spec: a range, a tag, a URL, a git reference or an alias. */
function looksLikeSpec(value: string): boolean {
  return (
    /^(?:[\^~<>=]|\d|\*$|[xX]$|[xX]\.)/.test(value) ||
    /^(?:latest|next|beta|alpha|canary|rc)$/i.test(value) ||
    /^(?:git(?:\+\w+)?|ssh|https?|file|link|npm|workspace|github|gitlab|bitbucket|gist):/i.test(
      value,
    ) ||
    /^git@/i.test(value) ||
    isShorthand(value)
  );
}

/** `user/repo` (a GitHub repository), not a path to a file such as `bin/cli.js`. */
function isShorthand(value: string): boolean {
  return (
    /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value) &&
    !/\.(?:[cm]?[jt]sx?|json|css|map|md|node|d\.ts)(?:#.*)?$/i.test(value)
  );
}

const redactLine = (line: string): string => redactSecrets(line.trim()).text.slice(0, 300);

interface Seen {
  name: string;
  section: string;
  value: string;
  line: number;
  text: string;
}

function readManifest(file: ChangedFile): {
  added: Seen[];
  deleted: Seen[];
} {
  const added: Seen[] = [];
  const deleted: Seen[] = [];
  if (!file.patch) return { added, deleted };

  for (const hunk of parsePatch(file.patch).hunks) {
    // The object a line sits in is only known when its opening line is inside the hunk; otherwise the value
    // decides (a version range is a dependency, an install-script name is a script).
    const stack: Array<{ name: string; indent: number }> = [];
    for (const line of hunk.lines) {
      if (line.type === "meta") continue;
      const open = SECTION_OPEN.exec(line.content);
      if (open && line.type !== "del") {
        stack.push({ name: open[2] ?? "", indent: (open[1] ?? "").length });
        continue;
      }
      const close = /^(\s*)\}/.exec(line.content);
      if (close && line.type !== "del") {
        const top = stack[stack.length - 1];
        if (top && (close[1] ?? "").length <= top.indent) stack.pop();
        continue;
      }
      if (line.type === "context") continue;
      const entry = ENTRY.exec(line.content);
      if (!entry) continue;
      const seen: Seen = {
        name: entry[1] ?? "",
        value: (entry[2] ?? "").replace(/\\(.)/g, "$1"),
        section: stack[stack.length - 1]?.name ?? "",
        line: line.newLine ?? 0,
        text: redactLine(line.content),
      };
      (line.type === "add" ? added : deleted).push(seen);
    }
  }
  return { added, deleted };
}

type Kind =
  { kind: "dependency"; section: DependencySection | "unknown" } | { kind: "script" } | undefined;

function classify(seen: Seen): Kind {
  if (DEPENDENCY_SECTIONS.has(seen.section)) {
    return { kind: "dependency", section: seen.section as DependencySection };
  }
  if (seen.section === "scripts") return { kind: "script" };
  if (seen.section !== "" && OTHER_SECTIONS.has(seen.section)) return undefined;
  if (seen.section !== "") return undefined;
  // Section unknown: decide by what the line is.
  if (INSTALL_SCRIPTS.has(seen.name) && !looksLikeSpec(seen.value)) return { kind: "script" };
  if (RESERVED_KEYS.has(seen.name)) return undefined;
  if (looksLikeSpec(seen.value)) return { kind: "dependency", section: "unknown" };
  return undefined;
}

const isManifest = (path: string): boolean => /(?:^|\/)package\.json$/.test(path);

/** Reads the dependency and script changes out of the patches of the pull request's `package.json` files. */
export function analyzeManifestChanges(files: readonly ChangedFile[]): ManifestChanges {
  const out: ManifestChanges = { dependencies: [], scripts: [], removed: [] };
  for (const file of files) {
    if (!isManifest(file.path) || file.status === "removed") continue;
    const { added, deleted } = readManifest(file);
    const before = new Map<string, string>();
    for (const seen of deleted) before.set(`${seen.section}\u0000${seen.name}`, seen.value);
    const after = new Set<string>();

    for (const seen of added) {
      const kind = classify(seen);
      if (!kind) continue;
      const key = `${seen.section}\u0000${seen.name}`;
      after.add(key);
      const from = before.get(key);
      if (from === seen.value) continue; // the line moved, nothing changed
      const base = {
        path: file.path,
        name: seen.name,
        to: seen.value,
        line: seen.line,
        text: seen.text,
      };
      if (kind.kind === "script") {
        out.scripts.push({ ...base, ...(from === undefined ? {} : { from }) });
      } else {
        out.dependencies.push({
          ...base,
          section: kind.section,
          ...(from === undefined ? {} : { from }),
        });
      }
    }
    for (const seen of deleted) {
      const kind = classify(seen);
      if (kind?.kind !== "dependency") continue;
      if (!after.has(`${seen.section}\u0000${seen.name}`)) {
        out.removed.push({ path: file.path, name: seen.name });
      }
    }
  }
  return out;
}

// ---------- rules ----------

/** The names most likely to be imitated. A name one edit away from one of these, and not one of these, is suspect. */
const POPULAR_PACKAGES: ReadonlySet<string> = new Set(
  (
    "react react-dom react-router react-router-dom react-native react-redux redux redux-thunk next vue vuex nuxt svelte " +
    "angular lodash underscore moment dayjs date-fns axios request node-fetch got superagent express koa fastify hapi " +
    "body-parser cors helmet morgan cookie-parser multer passport jsonwebtoken bcrypt bcryptjs uuid nanoid chalk " +
    "colors commander yargs inquirer debug dotenv async bluebird rxjs jquery bootstrap tailwindcss webpack webpack-cli " +
    "babel-core rollup vite esbuild parcel typescript ts-node tslib eslint prettier jest mocha chai sinon vitest " +
    "supertest cypress puppeteer playwright mongoose mongodb mysql mysql2 pg sequelize typeorm prisma knex redis ioredis " +
    "socket.io ws graphql apollo-server cheerio underscore.string minimist semver glob rimraf mkdirp fs-extra " +
    "lodash.merge lodash.get cross-env nodemon concurrently husky lint-staged zod joi yup ajv formik immer classnames " +
    "prop-types core-js regenerator-runtime sharp jimp nodemailer winston pino bunyan handlebars ejs pug marked " +
    "highlight.js d3 three chart.js http-proxy-middleware compression serve-static cookie-session express-session " +
    "connect-redis @nestjs/core @nestjs/common electron aws-sdk firebase stripe twilio dotenv-expand tough-cookie " +
    "node-sass sass less postcss autoprefixer eslint-plugin-react styled-components emotion mobx recoil swr " +
    "react-query axios-retry crypto-js md5 sha1 shelljs execa which ora open opn tar unzipper archiver yauzl " +
    "event-stream left-pad is-promise is-array color-convert ansi-styles strip-ansi string-width wrap-ansi"
  ).split(/\s+/),
);

const normalizeName = (name: string): string => name.replace(/[-_.]/g, "");

/** True when `a` and `b` differ by one insertion, deletion, substitution or swap of two neighbouring letters. */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // one substitution
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2); // one swap
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a];
  return longer.slice(i + 1) === shorter.slice(i);
}

/** The popular package `name` seems to imitate, if any. */
export function imitatedPackage(name: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) return undefined; // scoped names are owned by their scope
  if (POPULAR_PACKAGES.has(name)) return undefined;
  const flat = normalizeName(name);
  for (const popular of POPULAR_PACKAGES) {
    if (popular.startsWith("@")) continue;
    // `reactdom` for `react-dom`: the same name with the separators moved.
    if (flat.length >= 5 && flat === normalizeName(popular)) return popular;
    if (name.length >= 5 && popular.length >= 5 && oneEditApart(name, popular)) return popular;
  }
  return undefined;
}

const PINNED_GIT_COMMIT = /#[0-9a-f]{40}$/i;
const GIT_SPEC = /^(?:git(?:\+\w+)?:\/\/|git@|ssh:\/\/|github:|gitlab:|bitbucket:|gist:)/i;
const TARBALL_SPEC = /^https?:\/\//i;
const PLAIN_TRANSPORT = /^(?:git:\/\/|http:\/\/|git\+http:\/\/)/i;
const SUSPICIOUS_COMMAND =
  /\b(?:curl|wget|Invoke-WebRequest|iwr)\b|\|\s*(?:sh|bash|zsh|node|powershell)\b|\beval\b|base64\b|\bnode\s+-e\b|\bpowershell\b.*-enc|\bnc\s+-|\/dev\/tcp\//i;

export type DependencyRuleId =
  | "install_script"
  | "install_script_download"
  | "git_dependency"
  | "url_dependency"
  | "insecure_transport"
  | "typosquat";

export interface DependencySignal {
  rule: DependencyRuleId;
  /** `<path>:<line>` and the dependency or script name, for the prompt. */
  path: string;
  line: number;
  name: string;
  severity: Finding["severity"];
  confidence: number;
  title: string;
  evidence: string;
  impact: string;
  recommendation: string;
}

const NPM_INSTALL_HOOKS =
  "Anyone who installs the package, and every CI job that runs `npm install`, executes this command.";

/** The findings that follow from the manifest changes without a model's judgement. */
export function dependencySignals(changes: ManifestChanges): DependencySignal[] {
  const signals: DependencySignal[] = [];

  for (const script of changes.scripts) {
    if (!INSTALL_SCRIPTS.has(script.name)) continue;
    const download = SUSPICIOUS_COMMAND.test(script.to);
    signals.push({
      rule: download ? "install_script_download" : "install_script",
      path: script.path,
      line: script.line,
      name: script.name,
      severity: download ? "high" : "medium",
      confidence: download ? 0.9 : 0.85,
      title: `${script.from === undefined ? "New" : "Changed"} \`${script.name}\` install script${
        download ? " that downloads or evaluates code" : ""
      }`,
      evidence: script.text,
      impact: download
        ? `${NPM_INSTALL_HOOKS} It fetches or evaluates code at install time, which a compromised host or a later change to that code turns into code execution on developer machines and build servers.`
        : `${NPM_INSTALL_HOOKS} An install script is a way to run code the reviewer does not see in the diff of the package itself.`,
      recommendation: download
        ? "Remove the install script, or vendor and review what it runs. Do not fetch code at install time."
        : "Confirm the script is needed and what it runs. Prefer an explicit build step to an install hook, and consider `--ignore-scripts` in CI.",
    });
  }

  for (const dep of changes.dependencies) {
    const spec = dep.to;
    const where = `\`${dep.name}\``;
    if (PLAIN_TRANSPORT.test(spec)) {
      signals.push({
        rule: "insecure_transport",
        path: dep.path,
        line: dep.line,
        name: dep.name,
        severity: "high",
        confidence: 0.9,
        title: `Dependency ${where} is fetched over an unencrypted connection`,
        evidence: dep.text,
        impact:
          "A plain `http://` or `git://` source can be altered in transit, so the code that gets installed is not guaranteed to be the code that was reviewed.",
        recommendation:
          "Use a registry version, or an `https://` or `git+https://` source pinned to a full commit hash.",
      });
      continue;
    }
    const git = GIT_SPEC.test(spec) || isShorthand(spec);
    if (git && !PINNED_GIT_COMMIT.test(spec)) {
      signals.push({
        rule: "git_dependency",
        path: dep.path,
        line: dep.line,
        name: dep.name,
        severity: "medium",
        confidence: 0.9,
        title: `Dependency ${where} comes from a git repository without a pinned commit`,
        evidence: dep.text,
        impact:
          "A branch or tag can move. The next install may fetch different code from the one that was reviewed, and it bypasses the registry's checks.",
        recommendation:
          "Pin the dependency to a full 40-character commit hash, or publish and use a registry version.",
      });
      continue;
    }
    if (!git && TARBALL_SPEC.test(spec)) {
      signals.push({
        rule: "url_dependency",
        path: dep.path,
        line: dep.line,
        name: dep.name,
        severity: "medium",
        confidence: 0.9,
        title: `Dependency ${where} is installed from a URL instead of the registry`,
        evidence: dep.text,
        impact:
          "The file behind a URL can change without any change to this repository, so installs are not reproducible and the code is not the code that was reviewed.",
        recommendation:
          "Use a registry version, or host the package in a registry you control and pin its version.",
      });
      continue;
    }
    if (dep.from === undefined && !git && !TARBALL_SPEC.test(spec)) {
      const imitated = imitatedPackage(dep.name);
      if (imitated) {
        signals.push({
          rule: "typosquat",
          path: dep.path,
          line: dep.line,
          name: dep.name,
          severity: "medium",
          confidence: 0.8,
          title: `New dependency ${where} looks like a misspelling of \`${imitated}\``,
          evidence: dep.text,
          impact: `Packages with names close to popular ones are used to distribute malicious code to people who mistype. If ${where} is not the package that was meant, installing it runs someone else's code.`,
          recommendation: `Check the name against \`${imitated}\` and the package's publisher, downloads and repository before keeping it.`,
        });
      }
    }
  }
  return signals;
}

/** The signals as findings of the Security agent. */
export function signalFindings(signals: readonly DependencySignal[], headSha: string): Finding[] {
  return signals.map((signal) => ({
    id: fingerprintFinding({
      category: "security",
      title: signal.title,
      filePath: signal.path,
      startLine: signal.line,
    }),
    agent: "security",
    category: "security",
    severity: signal.severity,
    confidence: signal.confidence,
    title: signal.title,
    filePath: signal.path,
    startLine: signal.line,
    endLine: signal.line,
    evidence: signal.evidence,
    impact: signal.impact,
    recommendation: signal.recommendation,
    sourceCommitSha: headSha,
  }));
}

// ---------- the prompt section ----------

const MAX_LISTED = 25;
const specText = (value: string): string => redactSecrets(value).text.slice(0, 120);

/**
 * The "Dependency changes" section of the prompt, or `undefined` when no manifest changed. Facts first, then the
 * findings the platform has already made, so the model does not repeat them.
 */
export function dependencySection(
  changes: ManifestChanges,
  signals: readonly DependencySignal[],
): { title: string; body: string } | undefined {
  if (
    changes.dependencies.length === 0 &&
    changes.scripts.length === 0 &&
    changes.removed.length === 0
  ) {
    return undefined;
  }
  const lines: string[] = [
    "Read from the package.json diffs by the platform. Lockfiles are not shown. Versions are as written in the manifest.",
  ];
  const added = changes.dependencies.filter((d) => d.from === undefined);
  const changed = changes.dependencies.filter((d) => d.from !== undefined);
  const list = <T>(title: string, items: T[], render: (item: T) => string) => {
    if (items.length === 0) return;
    lines.push("", `${title}:`, ...items.slice(0, MAX_LISTED).map((item) => `- ${render(item)}`));
    if (items.length > MAX_LISTED) lines.push(`- ...and ${items.length - MAX_LISTED} more`);
  };
  list(
    "New dependencies",
    added,
    (d) => `${d.name}@${specText(d.to)} (${d.section}, ${d.path}:${d.line})`,
  );
  list(
    "Changed dependencies",
    changed,
    (d) =>
      `${d.name}: ${specText(d.from ?? "")} -> ${specText(d.to)} (${d.section}, ${d.path}:${d.line})`,
  );
  list(
    "Removed dependencies",
    changes.removed.map((r) => ({ ...r })),
    (r) => `${r.name} (${r.path})`,
  );
  list(
    "Added or changed scripts",
    changes.scripts,
    (s) =>
      `${s.name}${INSTALL_SCRIPTS.has(s.name) ? " (runs on install)" : ""}: ${specText(s.to)} (${s.path}:${s.line})`,
  );
  if (signals.length > 0) {
    lines.push(
      "",
      "Already reported by the platform as findings (do not report these again):",
      ...signals.slice(0, MAX_LISTED).map((s) => `- ${s.path}:${s.line} ${s.name}: ${s.rule}`),
    );
  }
  return { title: "Dependency changes", body: lines.join("\n") };
}
