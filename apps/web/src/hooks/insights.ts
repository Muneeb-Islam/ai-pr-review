// Queries and mutations for the findings explorer, feedback, pull request history, run actions and analytics.
import type { CallResult } from "@ai-pr-review/shared/api";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useApi } from "../app/api";
import { queryKeys } from "./queries";

export type ExplorerFinding = CallResult<"listFindings">["items"][number];
export type FeedbackSummary = CallResult<"giveFeedback">["feedback"];
export type FeedbackVerdict = "useful" | "false_positive" | "known";
export type PullHistory = CallResult<"getPullHistory">;
export type AnalyticsSummary = CallResult<"getAnalyticsSummary">;
export type AnalyticsTimeseries = CallResult<"getAnalyticsTimeseries">;

/** Filters of the findings explorer; an empty string means "not set". */
export interface FindingFilters {
  repo_id?: string;
  severity?: string;
  category?: string;
  agent?: string;
  status?: string;
  path?: string;
  from?: string;
  to?: string;
}

const PAGE_SIZE = 25;

const clean = <T extends object>(filters: T): Partial<T> =>
  Object.fromEntries(Object.entries(filters).filter(([, value]) => value)) as Partial<T>;

export interface FindingPage {
  items: ExplorerFinding[];
  next: string | null;
}

/** Findings in pages of 25; `fetchNextPage` follows the cursor. */
export function useFindingList(
  filters: FindingFilters,
): UseInfiniteQueryResult<InfiniteData<FindingPage, string | undefined>> {
  const api = useApi();
  const query = clean(filters);
  return useInfiniteQuery({
    queryKey: [...queryKeys.findings, "list", query] as const,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<FindingPage> => {
      const page = await api.call("listFindings", {
        // The api validates the values; the contract types them as its enums.
        query: {
          ...query,
          limit: PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        } as never,
      });
      return { items: page.items, next: page.next_cursor };
    },
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

export function useFinding(id: string): UseQueryResult<ExplorerFinding> {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.finding(id),
    queryFn: () => api.call("getFinding", { params: { id } }),
  });
}

/** Everything a vote can change: finding lists, one finding, run pages and the numbers in analytics. */
function invalidateFeedback(client: QueryClient, findingId: string) {
  void client.invalidateQueries({ queryKey: queryKeys.findings });
  void client.invalidateQueries({ queryKey: queryKeys.finding(findingId) });
  void client.invalidateQueries({ queryKey: ["run"] });
  void client.invalidateQueries({ queryKey: queryKeys.analytics });
}

export function useGiveFeedback(findingId: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { verdict: FeedbackVerdict; note?: string }) =>
      (
        await api.call("giveFeedback", {
          params: { id: findingId },
          body: { verdict: input.verdict, ...(input.note ? { note: input.note } : {}) },
        })
      ).feedback,
    onSuccess: () => invalidateFeedback(client, findingId),
  });
}

export function usePullHistory(repoId: string, number: number): UseQueryResult<PullHistory> {
  const api = useApi();
  return useQuery({
    queryKey: ["history", repoId, number] as const,
    queryFn: () => api.call("getPullHistory", { params: { id: repoId, number } }),
  });
}

// ---------- run actions ----------

export function useRerun(runId: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.call("rerunRun", { params: { id: runId } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.runs });
      void client.invalidateQueries({ queryKey: ["history"] });
      void client.invalidateQueries({ queryKey: queryKeys.repos });
    },
  });
}

export function useCancel(runId: string) {
  const api = useApi();
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.call("cancelRun", { params: { id: runId } }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.runs });
      void client.invalidateQueries({ queryKey: queryKeys.run(runId) });
      void client.invalidateQueries({ queryKey: queryKeys.repos });
    },
  });
}

// ---------- analytics ----------

/** The last `days` days up to now. Only `from` is sent, so the api's "now" is the end and the key stays stable. */
const sinceDays = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export function useAnalyticsSummary(
  repoId: string,
  days: number,
): UseQueryResult<AnalyticsSummary> {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.analytics, "summary", repoId, days] as const,
    queryFn: () =>
      api.call("getAnalyticsSummary", {
        query: { from: sinceDays(days), ...(repoId ? { repo_id: repoId } : {}) },
      }),
  });
}

export function useAnalyticsTimeseries(
  repoId: string,
  days: number,
): UseQueryResult<AnalyticsTimeseries> {
  const api = useApi();
  return useQuery({
    queryKey: [...queryKeys.analytics, "timeseries", repoId, days] as const,
    queryFn: () =>
      api.call("getAnalyticsTimeseries", {
        query: { from: sinceDays(days), ...(repoId ? { repo_id: repoId } : {}) },
      }),
  });
}
