import { z } from "zod";
import type { RepoRef } from "../github/client";

/**
 * The slice of Octokit this module uses: `octokit.request(route, params)`. `GitHubClient` fits, and tests pass a
 * fake. Every call carries the run's abort signal.
 */
export interface ContextClient {
  request(route: string, params?: Record<string, unknown>): Promise<{ data: unknown }>;
}

export const PER_PAGE = 100;

/** GitHub lists at most 3000 files per pull request. */
export const MAX_FILE_PAGES = 30;
export const MAX_COMMENT_PAGES = 20;

/** GitHub answered, but not with the shape this code expects. The message never includes the payload. */
export class UnexpectedResponseError extends Error {
  constructor(route: string) {
    super(`Unexpected GitHub response for ${route}.`);
    this.name = "UnexpectedResponseError";
  }
}

export function isNotFound(err: unknown): boolean {
  return (err as { status?: number } | null)?.status === 404;
}

export function repoParams(repo: RepoRef): { owner: string; repo: string } {
  return { owner: repo.owner, repo: repo.repo };
}

export async function call<T>(
  client: ContextClient,
  signal: AbortSignal | undefined,
  route: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const { data } = await client.request(route, {
    ...params,
    ...(signal ? { request: { signal } } : {}),
  });
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new UnexpectedResponseError(route);
  }
  return parsed.data;
}

/** Fetches every page of a list endpoint, stopping at a short page or `maxPages`. */
export async function listPages<T>(
  client: ContextClient,
  signal: AbortSignal | undefined,
  route: string,
  params: Record<string, unknown>,
  item: z.ZodType<T>,
  maxPages: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  const page = z.array(item);
  for (let n = 1; n <= maxPages; n += 1) {
    const batch = await call(
      client,
      signal,
      route,
      { ...params, per_page: PER_PAGE, page: n },
      page,
    );
    items.push(...batch);
    if (batch.length < PER_PAGE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

// ---------- response shapes (only the fields used; unknown fields are ignored) ----------

export const pullSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
  changed_files: z.number().optional(),
  base: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
  head: z.object({
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});

export const fileSchema = z.object({
  filename: z.string(),
  status: z.string(),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  changes: z.number().default(0),
  patch: z.string().optional(),
  previous_filename: z.string().optional(),
});

export const commentSchema = z.object({
  id: z.number(),
  body: z.string().nullable().optional(),
  path: z.string().optional(),
  user: z.object({ login: z.string(), type: z.string().optional() }).nullable().optional(),
});

export const contentSchema = z.object({
  type: z.string(),
  size: z.number().optional(),
  encoding: z.string().optional(),
  content: z.string().optional(),
});

export const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), type: z.string() })),
});

/** Decodes the base64 body of a contents API file; `undefined` for anything that is not a text file. */
export function decodeContent(content: z.infer<typeof contentSchema>): string | undefined {
  if (content.type !== "file" || content.encoding !== "base64" || content.content === undefined) {
    return undefined;
  }
  return Buffer.from(content.content, "base64").toString("utf8");
}
