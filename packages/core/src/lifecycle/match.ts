import type { AgentId, Category, Finding, Severity } from "@ai-pr-review/shared";
import { normalizeTitle } from "../validation/fingerprint";

// Matching a finding of this run with one of the previous review (FR-36, FR-37). The fingerprint of design §12
// is the first test: it is cheap and exact. It is also brittle by design (a title reworded by the model, or a
// finding that moves across a five-line bucket boundary, gets a new fingerprint), so findings the fingerprint
// does not pair are paired by what a person would compare: same file, same kind of problem, a similar sentence,
// a nearby line. Too strict a match makes a persisting finding look new (and posts it again); too loose a match
// hides a new finding behind an old one, so the loose rule needs all four to agree.

/** What the previous review recorded about one of its findings. */
export interface PreviousFinding {
  fingerprint: string;
  agent: AgentId;
  category: Category;
  severity: Severity;
  title: string;
  filePath?: string | undefined;
  startLine?: number | undefined;
  /** An inline comment for it is on the pull request. */
  posted: boolean;
}

/** Lines a finding may move (code inserted above it) and still be the same finding. */
export const LINE_SHIFT_TOLERANCE = 10;
/** Share of words two titles must have in common (Jaccard) to be called the same sentence. */
export const TITLE_SIMILARITY = 0.7;

function words(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(" ").filter(Boolean));
}

export function similarTitles(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return false;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / (x.size + y.size - shared) >= TITLE_SIMILARITY;
}

/** Distance between two findings' lines, or undefined when they are not about the same file and spot. */
function lineDistance(
  current: Pick<Finding, "filePath" | "startLine">,
  previous: PreviousFinding,
): number | undefined {
  if (current.filePath !== previous.filePath) return undefined;
  if (current.startLine === undefined || previous.startLine === undefined) {
    return current.startLine === previous.startLine ? 0 : undefined;
  }
  const distance = Math.abs(current.startLine - previous.startLine);
  return distance <= LINE_SHIFT_TOLERANCE ? distance : undefined;
}

export interface Matches {
  /** Each finding of this run that continues a finding of the previous review. */
  pairs: Map<Finding, PreviousFinding>;
  /** Findings of the previous review that nothing in this run continues. */
  unmatched: PreviousFinding[];
}

/** Pairs findings one to one: by fingerprint first, then by file, category, title and line. */
export function matchFindings(
  current: readonly Finding[],
  previous: readonly PreviousFinding[],
): Matches {
  const pairs = new Map<Finding, PreviousFinding>();
  const free = new Set(previous);

  for (const finding of current) {
    const exact = [...free].find((p) => p.fingerprint === finding.id);
    if (!exact) continue;
    pairs.set(finding, exact);
    free.delete(exact);
  }

  for (const finding of current) {
    if (pairs.has(finding)) continue;
    let best: { previous: PreviousFinding; distance: number } | undefined;
    for (const candidate of free) {
      if (candidate.category !== finding.category) continue;
      const distance = lineDistance(finding, candidate);
      if (distance === undefined || !similarTitles(finding.title, candidate.title)) continue;
      if (!best || distance < best.distance) best = { previous: candidate, distance };
    }
    if (!best) continue;
    pairs.set(finding, best.previous);
    free.delete(best.previous);
  }

  return { pairs, unmatched: previous.filter((p) => free.has(p)) };
}
