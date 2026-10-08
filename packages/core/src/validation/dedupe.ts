import type { Finding } from "@ai-pr-review/shared";
import { SEVERITY_RANK } from "./severity";

/** Most severe first, then most confident, then by place, so the order is stable and useful in a summary. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    b.confidence - a.confidence ||
    (a.filePath ?? "").localeCompare(b.filePath ?? "") ||
    (a.startLine ?? 0) - (b.startLine ?? 0) ||
    a.id.localeCompare(b.id)
  );
}

export interface DedupeResult {
  unique: Finding[];
  duplicates: Finding[];
}

/**
 * Keeps one finding per fingerprint (`Finding.id`): the first in `compareFindings` order, so the most severe and
 * most confident wins. Fingerprints in `alreadyPosted`, when given, are all duplicates. The result is sorted.
 */
export function dedupeByFingerprint(
  findings: readonly Finding[],
  alreadyPosted: Iterable<string> = [],
): DedupeResult {
  const seen = new Set<string>(alreadyPosted);
  const unique: Finding[] = [];
  const duplicates: Finding[] = [];
  for (const finding of [...findings].sort(compareFindings)) {
    if (seen.has(finding.id)) {
      duplicates.push(finding);
    } else {
      seen.add(finding.id);
      unique.push(finding);
    }
  }
  return { unique, duplicates };
}
