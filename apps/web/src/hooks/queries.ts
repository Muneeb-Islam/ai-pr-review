import { ApiError, type CallResult } from "@ai-pr-review/shared/api";
import {
  useInfiniteQuery,
  type InfiniteData,
  useQuery,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useApi } from "../app/api";

export type Me = CallResult<"me">;
export type Repo = CallResult<"listRepos">["items"][number];
export type RunSummary = CallResult<"listRuns">["items"][number];
export type RunDetail = CallResult<"getRun">;
export type RepoDetail = CallResult<"getRepo">;

/** Filters of the runs list; every field is optional and an empty string means "not set". */
export interface RunFilters {
  repo_id?: string;
  status?: string;
  branch?: string;
  from?: string;
  to?: string;
}

export const queryKeys = {
  me: ["me"] as const,
  repos: ["repos"] as const,
  /** Prefix of every runs query: one `invalidateQueries` refreshes lists and pages alike. */
  runs: ["runs"] as const,
  runList: (filters: RunFilters) => ["runs", "list", filters] as const,
  run: (id: string) => ["run", id] as const,
  repo: (id: string) => ["repo", id] as const,
  /** Prefix of every findings query. */
  findings: ["findings"] as const,
  finding: (id: string) => ["finding", id] as const,
  /** Prefix of every analytics query. */
  analytics: ["analytics"] as const,
  /** Prefix of every settings query. */
  settings: ["settings"] as const,
};

/** 4xx answers are final: retrying a 401 or a 404 only delays the message. */
export const shouldRetry = (failures: number, error: unknown): boolean =>
  !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 2;

const PAGE_SIZE = 25;

const clean = (filters: RunFilters) =>
  Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as RunFilters;

/**
 * The signed-in user, or null when there is no session (a 401 is an answer here, not an error). The auth
 * guard and the account menu read this one query.
 */
export function useMe(): UseQueryResult<Me | null> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: async () => {
      try {
        return await api.call("me");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useRepos(): UseQueryResult<Repo[]> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.repos,
    queryFn: async () => (await api.call("listRepos")).items,
  });
}

export interface RunPage {
  items: RunSummary[];
  next: string | null;
}

/** A run list in pages; `fetchNextPage` follows the cursor. Flatten with `data.pages.flatMap((p) => p.items)`. */
export function useRunList(
  filters: RunFilters,
  options: { limit?: number; enabled?: boolean } = {},
): UseInfiniteQueryResult<InfiniteData<RunPage, string | undefined>> {
  const api = useApi();
  const query = clean(filters);
  return useInfiniteQuery({
    queryKey: queryKeys.runList(query),
    enabled: options.enabled ?? true,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<RunPage> => {
      const page = await api.call("listRuns", {
        query: {
          ...query,
          limit: options.limit ?? PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      });
      return { items: page.items, next: page.next_cursor };
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

export function useRun(id: string): UseQueryResult<RunDetail> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.run(id),
    queryFn: () => api.call("getRun", { params: { id } }),
  });
}

export function useRepo(id: string): UseQueryResult<RepoDetail> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.repo(id),
    queryFn: () => api.call("getRepo", { params: { id } }),
  });
}
