import type { Finding, Severity } from "@ai-pr-review/shared";
import { createPathClassifier } from "../../context/classify";
import type { ChangedFile, ReviewContext } from "../../context/types";
import { SECURITY_PROMPT } from "../../prompts/security.v1";
import {
  analyzeManifestChanges,
  secretLiteralsIn,
  dependencySection,
  dependencySignals,
  sanitizeSecurityText,
  securityScrub,
  signalFindings,
} from "../../security";
import { createLlmAgent, type PreparedRun } from "../structured";
import type { AgentTask } from "../types";

/** Most findings one run carries. A review that lists more than this is generic advice, not a review. */
export const MAX_SECURITY_FINDINGS = 12;

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const DOCUMENTS = /\.(?:md|mdx|txt|rst|adoc)$/i;
const classifier = createPathClassifier({ ignore: [], secretPaths: [] });

/**
 * What the Security agent reads: changed code and configuration, `package.json` included, that was not deleted.
 * Documentation and test files are left out (a fixture's fake token is not a leak and would drown the real
 * findings); lockfiles and build output never get this far, Phase 5 excluded them.
 */
export function selectSecurityFiles(context: ReviewContext): ChangedFile[] {
  return context.files.filter(
    (file) =>
      file.status !== "removed" &&
      Boolean(file.patch) &&
      !DOCUMENTS.test(file.path) &&
      !classifier.isTestPath(file.path),
  );
}

/** One line of at most this many characters: the prompt asks for it, and a model that ignores it is cut. */
const EVIDENCE_LINE_MAX = 200;

/** Credentials and exploit payloads are removed from every text field before it can be stored or posted (FR-29). */
export function cleanSecurityFinding(finding: Finding, fromDiff: readonly string[] = []): Finding {
  // The secrets of the diff, and any the finding itself shows, are removed from every field, whatever its shape.
  const scrub = { known: [...fromDiff, ...securityScrub(finding).known] };
  const clean = (text: string): string => sanitizeSecurityText(text, scrub).text;
  const firstLine =
    finding.evidence
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const { suggestedTest: _dropped, ...rest } = finding;
  return {
    ...rest,
    title: clean(finding.title),
    evidence: clean(firstLine).slice(0, EVIDENCE_LINE_MAX),
    impact: clean(finding.impact),
    recommendation: clean(finding.recommendation),
  };
}

/**
 * Final say over what the model returned: clean it, add the findings the dependency rules made, drop a model finding
 * that repeats one of them (same file and line), most serious first, at most `MAX_SECURITY_FINDINGS`. The thresholds
 * are the validator's, afterwards.
 */
export function refineSecurityFindings(findings: Finding[], task: AgentTask): Finding[] {
  const added = task.files
    .flatMap((file) => (file.patch ?? "").split("\n"))
    .filter((line) => line.startsWith("+"))
    .join("\n");
  const fromDiff = secretLiteralsIn(added);
  const rules = signalFindings(
    dependencySignals(analyzeManifestChanges(task.files)),
    task.context.pr.headSha,
  ).map((finding) => cleanSecurityFinding(finding, fromDiff));
  const taken = new Set(rules.map((f) => `${f.filePath}:${f.startLine}`));
  const fromModel = findings
    .filter((f) => !(f.filePath !== undefined && taken.has(`${f.filePath}:${f.startLine}`)))
    .map((finding) => cleanSecurityFinding(finding, fromDiff));
  return [...rules, ...fromModel]
    .sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.confidence - a.confidence)
    .slice(0, MAX_SECURITY_FINDINGS);
}

async function prepare(task: AgentTask): Promise<PreparedRun> {
  const changes = analyzeManifestChanges(task.files);
  const section = dependencySection(changes, dependencySignals(changes));
  return section ? { sections: [section] } : {};
}

/**
 * Security agent (FR-26, design §10): a model reads the diff for the weaknesses the prompt lists, helped by the
 * dependency review of `package.json` (code, not the model: install scripts, git and URL sources, imitated names).
 * Everything it returns is cleaned of credentials and exploit payloads before it leaves the agent (FR-29). It is
 * advisory: the summary says so and points to SAST and dependency scanning for guarantees.
 */
export const securityAgent = createLlmAgent({
  id: "security",
  label: "Security",
  prompt: SECURITY_PROMPT,
  categories: ["security"],
  selectFiles: selectSecurityFiles,
  prepare,
  refine: refineSecurityFindings,
});
