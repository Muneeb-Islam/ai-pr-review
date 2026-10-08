import { createHash } from "node:crypto";
import type { Category } from "@ai-pr-review/shared";

/** Lines per fingerprint bucket (design §12): a finding that moves a few lines keeps its fingerprint. */
export const FINGERPRINT_LINE_BUCKET = 5;

/** Lowercase, punctuation and repeated whitespace collapsed, so "Missing  await!" and "missing await" match. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export interface FingerprintInput {
  category: Category;
  title: string;
  filePath?: string | undefined;
  startLine?: number | undefined;
}

/**
 * Design §12: the first 16 hex characters of `sha256(filePath + normalizedTitle + category + floor(startLine / 5))`.
 * A finding without a file or a line hashes an empty path and bucket 0. The fields are joined with a separator
 * that cannot occur in a normalized title, so `a|bc` and `ab|c` differ.
 */
export function fingerprintFinding(input: FingerprintInput): string {
  const bucket = Math.floor((input.startLine ?? 0) / FINGERPRINT_LINE_BUCKET);
  const material = [input.filePath ?? "", normalizeTitle(input.title), input.category, bucket].join(
    "\u0000",
  );
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
