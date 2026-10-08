import { createApiClient, type ApiClient } from "@ai-pr-review/shared/api";
import { createContext, useContext } from "react";

/**
 * The typed API client, generated from the same contract the api validates with (packages/shared/src/api).
 * Same origin by default (the dev server proxies /api and /auth); set VITE_API_URL to call another origin.
 * Calls send the session cookie and the CSRF token automatically.
 */
export const defaultApi = createApiClient({ baseUrl: import.meta.env["VITE_API_URL"] ?? "" });

/** Components get the client from context, so tests can hand them one that points at a mock server. */
export const ApiContext = createContext<ApiClient>(defaultApi);
export const useApi = (): ApiClient => useContext(ApiContext);
