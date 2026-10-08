import type { RepoRef } from "../github/client";
import {
  call,
  contentSchema,
  decodeContent,
  isNotFound,
  repoParams,
  type ContextClient,
} from "./github";
import { redactSecrets } from "./redact";
import type { ReviewContext } from "./types";

/** Nearby code is fetched on demand (FR-07). These bounds keep API volume and prompt size predictable. */
export interface NearbyLimits {
  /** Lines of context on each side of the range when no enclosing function is used. */
  radiusLines: number;
  /** Largest file the reader will fetch, in bytes (the contents API itself stops at 1 MB). */
  maxFileBytes: number;
  /** Largest snippet returned, in characters. Longer ones are cut at a line boundary. */
  maxSnippetCharacters: number;
  /** Snippets fetched per reader (one reader per run). */
  maxSnippets: number;
  /** Characters across all snippets of the reader. */
  maxTotalCharacters: number;
}

export const DEFAULT_NEARBY_LIMITS: NearbyLimits = {
  radiusLines: 20,
  maxFileBytes: 200 * 1024,
  maxSnippetCharacters: 6_000,
  maxSnippets: 30,
  maxTotalCharacters: 60_000,
};

export interface NearbySnippet {
  path: string;
  /** First and last line of the snippet, new-file numbering at the head SHA. */
  startLine: number;
  endLine: number;
  /** Secrets are redacted. */
  text: string;
  /** Whether the snippet is the enclosing function rather than a fixed window. */
  enclosingFunction: boolean;
}

export type NearbyResult =
  | { ok: true; snippet: NearbySnippet }
  | {
      ok: false;
      reason: "not_in_review" | "too_large" | "not_found" | "budget_exhausted" | "unreadable";
    };

export interface NearbyOptions {
  client: ContextClient;
  repo: RepoRef;
  context: Pick<ReviewContext, "files" | "pr">;
  limits?: Partial<NearbyLimits>;
  signal?: AbortSignal | undefined;
}

export interface NearbyCodeReader {
  /** Code around `startLine`..`endLine` of a file in the review, read at the head SHA. */
  read(path: string, startLine: number, endLine?: number): Promise<NearbyResult>;
}

const CONTROL_KEYWORDS = /^\s*(?:if|for|while|switch|catch|with|return|else|do|try)\b/;
const DECLARATION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\b|class\b)|^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>|^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*[\w$]+\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/;

const isDeclaration = (line: string): boolean =>
  !CONTROL_KEYWORDS.test(line) && DECLARATION.test(line);
const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Finds the function or class that contains `lineIndex` (0-based) by indentation: walks up to the nearest
 * declaration-looking line indented less than the target (or the target itself), then down to the line that closes
 * it. A heuristic for JS/TS; it returns `undefined` rather than guess when nothing encloses the line.
 */
export function findEnclosingBlock(
  lines: readonly string[],
  lineIndex: number,
): { start: number; end: number } | undefined {
  const target = lines[lineIndex];
  if (target === undefined) return undefined;
  const targetIndent = target.trim() === "" ? Number.MAX_SAFE_INTEGER : indentOf(target);

  for (let i = lineIndex; i >= 0; i -= 1) {
    const line = lines[i] as string;
    if (!isDeclaration(line)) continue;
    if (i !== lineIndex && indentOf(line) >= targetIndent) continue;

    // The block ends at the first later line that is back at the declaration's indentation: a closing
    // bracket belongs to it, anything else (the next declaration) does not.
    const baseIndent = indentOf(line);
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j] as string;
      if (next.trim() === "" || indentOf(next) > baseIndent) continue;
      end = /^\s*[})\]]/.test(next) ? j : j - 1;
      break;
    }
    if (end >= lineIndex) return { start: i, end };
    // This declaration closed before the target; an outer one may still contain it.
  }
  return undefined;
}

/**
 * A reader for code around the changed lines, using the contents API at the head SHA. It only reads files that are
 * in the review (so excluded and secret files are never fetched), caches files, redacts secrets, and stops at the
 * configured budget. Call it only where the diff's own three context lines are not enough.
 */
export function createNearbyCodeReader(options: NearbyOptions): NearbyCodeReader {
  const limits: NearbyLimits = { ...DEFAULT_NEARBY_LIMITS, ...options.limits };
  const { client, repo, context, signal } = options;
  const inReview = new Set(context.files.filter((f) => f.status !== "removed").map((f) => f.path));
  const cache = new Map<string, Promise<string | "too_large" | "not_found" | "unreadable">>();
  let snippets = 0;
  let characters = 0;

  const load = (path: string): Promise<string | "too_large" | "not_found" | "unreadable"> => {
    let pending = cache.get(path);
    if (!pending) {
      pending = (async () => {
        try {
          const content = await call(
            client,
            signal,
            "GET /repos/{owner}/{repo}/contents/{path}",
            { ...repoParams(repo), path, ref: context.pr.headSha },
            contentSchema,
          );
          if ((content.size ?? 0) > limits.maxFileBytes) return "too_large" as const;
          return decodeContent(content) ?? ("unreadable" as const);
        } catch (err) {
          if (isNotFound(err)) return "not_found" as const;
          throw err;
        }
      })();
      cache.set(path, pending);
    }
    return pending;
  };

  return {
    async read(path, startLine, endLine = startLine) {
      if (!inReview.has(path)) return { ok: false, reason: "not_in_review" };
      if (snippets >= limits.maxSnippets || characters >= limits.maxTotalCharacters) {
        return { ok: false, reason: "budget_exhausted" };
      }
      const file = await load(path);
      if (file === "too_large" || file === "not_found" || file === "unreadable") {
        return { ok: false, reason: file };
      }

      const lines = file.split("\n");
      const first = Math.max(1, Math.min(startLine, lines.length));
      const last = Math.max(first, Math.min(endLine, lines.length));

      let from = Math.max(1, first - limits.radiusLines);
      let to = Math.min(lines.length, last + limits.radiusLines);
      let enclosingFunction = false;
      const block = findEnclosingBlock(lines, first - 1);
      if (block && block.end + 1 >= last) {
        const blockText = lines.slice(block.start, block.end + 1).join("\n");
        if (blockText.length <= limits.maxSnippetCharacters) {
          from = block.start + 1;
          to = block.end + 1;
          enclosingFunction = true;
        }
      }

      let text = lines.slice(from - 1, to).join("\n");
      if (text.length > limits.maxSnippetCharacters) {
        // Cut at a line boundary and report the line the snippet really ends on.
        const cut = text.lastIndexOf("\n", limits.maxSnippetCharacters);
        text = text.slice(0, cut > 0 ? cut : limits.maxSnippetCharacters);
        to = from + text.split("\n").length - 1;
      }

      const redacted = redactSecrets(text).text;
      snippets += 1;
      characters += redacted.length;
      return {
        ok: true,
        snippet: { path, startLine: from, endLine: to, text: redacted, enclosingFunction },
      };
    },
  };
}
