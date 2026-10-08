import { ApiError } from "@ai-pr-review/shared/api";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { queryKeys, shouldRetry } from "../hooks/queries";

/**
 * One place for what every query shares. A 401 from any query means the session ended (idle timeout, sign-out
 * in another tab): the cached identity is cleared, which sends the auth guard to the login page.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (
          error instanceof ApiError &&
          error.status === 401 &&
          query.queryKey[0] !== queryKeys.me[0]
        ) {
          client.setQueryData(queryKeys.me, null);
        }
      },
    }),
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        staleTime: 10_000,
        refetchOnWindowFocus: true,
      },
    },
  });
  return client;
}
