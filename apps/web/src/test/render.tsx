import { createApiClient } from "@ai-pr-review/shared/api";
import type { QueryClient } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { AppProviders, AppRoutes } from "../App";
import { createQueryClient } from "../app/queryClient";
import { API, makeMe, type MeDto } from "./fixtures";
import { server } from "./server";

/** A client that talks to the mock server (Node's fetch needs an absolute URL). */
export const testApi = () => createApiClient({ baseUrl: API });

/** The app's query client without retries and backoff, so error states show immediately. */
export function testQueryClient(): QueryClient {
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  return client;
}

export const json = (body: unknown, status = 200) => HttpResponse.json(body as never, { status });

export const apiError = (status: number, code: string, message = "Failed") =>
  json({ error: { code, message, request_id: "req-test-1" } }, status);

/** Answers `GET /api/me` as a signed-in user (or 401 when `null`). */
export function signedInAs(me: MeDto | null = makeMe()): void {
  server.use(
    http.get(`${API}/api/me`, () =>
      me ? json(me) : apiError(401, "unauthorized", "Sign in to continue"),
    ),
  );
}

/** Shows the router's current location so a test can assert where the app navigated. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

export function renderApp(
  route = "/repos",
  options: { queryClient?: QueryClient } = {},
): { queryClient: QueryClient } & ReturnType<typeof render> {
  const queryClient = options.queryClient ?? testQueryClient();
  // The same kind of router as main.tsx (a data router: pages block navigation with `useBlocker`).
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <>
            <AppRoutes />
            <LocationProbe />
          </>
        ),
      },
    ],
    { initialEntries: [route] },
  );
  const utils = render(
    <AppProviders api={testApi()} queryClient={queryClient}>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { ...utils, queryClient };
}
