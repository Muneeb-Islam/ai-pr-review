// Typed API client for the web app, derived from the endpoint table: calls, parameters and results are
// checked against the same zod contracts the api validates with. No Node-only imports (it runs in browsers).
import type { z } from "zod";
import { endpoints, isMutation, type EndpointName, type Endpoints } from "./contract";
import { errorResponseSchema } from "./schemas";

/** Endpoints that are browser navigations (redirects) or event streams, not JSON calls. */
type NavigationEndpoint = "login" | "loginCallback" | "events" | "exportCsv";
export type CallableEndpoint = Exclude<EndpointName, NavigationEndpoint>;

type Def<K extends EndpointName> = Endpoints[K];

type ParamsInput<K extends EndpointName> =
  Def<K> extends { params: infer P extends z.ZodType } ? { params: z.input<P> } : unknown;

type QueryInput<K extends EndpointName> =
  Def<K> extends { query: infer Q extends z.ZodType }
    ? Partial<z.input<Q>> extends z.input<Q>
      ? { query?: z.input<Q> }
      : { query: z.input<Q> }
    : unknown;

type BodyInput<K extends EndpointName> =
  Def<K> extends { body: infer B extends z.ZodType } ? { body: z.input<B> } : unknown;

export type CallInput<K extends EndpointName> = ParamsInput<K> & QueryInput<K> & BodyInput<K>;
export type CallResult<K extends EndpointName> = z.output<Def<K>["response"]>;

type CallArgs<K extends EndpointName> =
  Partial<CallInput<K>> extends CallInput<K> ? [input?: CallInput<K>] : [input: CallInput<K>];

/** A non-2xx answer. `code` is the stable machine-readable code from the error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** Origin of the api, without a trailing slash. Empty = same origin (a dev proxy or a combined deployment). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let csrfToken: string | undefined;

  async function send(
    name: CallableEndpoint,
    input: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown },
    retriedCsrf = false,
  ): Promise<unknown> {
    const def = endpoints[name];
    let path: string = def.path;
    for (const [key, value] of Object.entries(input.params ?? {})) {
      path = path.replace(`:${key}`, encodeURIComponent(value));
    }
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined && value !== null) search.set(key, String(value));
    }
    const url = `${baseUrl}${path}${search.size > 0 ? `?${search}` : ""}`;

    const headers: Record<string, string> = { accept: "application/json" };
    if (isMutation(def.method)) {
      if (csrfToken === undefined && name !== "me") await send("me", {});
      if (csrfToken !== undefined) headers["x-csrf-token"] = csrfToken;
    }
    const hasBody = "body" in def && input.body !== undefined;
    if (hasBody) headers["content-type"] = "application/json";

    const response = await doFetch(url, {
      method: def.method,
      credentials: "include",
      headers,
      ...(hasBody ? { body: JSON.stringify(input.body) } : {}),
    });

    const text = await response.text();
    const json: unknown = text === "" ? undefined : JSON.parse(text);
    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(json);
      if (parsed.success) {
        const { code, message, details, request_id } = parsed.data.error;
        // The CSRF token belongs to the session: a rejected token means it changed, fetch it again once.
        if (code === "csrf_invalid" && !retriedCsrf) {
          csrfToken = undefined;
          return send(name, input, true);
        }
        throw new ApiError(response.status, code, message, details, request_id);
      }
      throw new ApiError(response.status, "unknown_error", `Request failed (${response.status})`);
    }
    const result = def.response.parse(json ?? null);
    if (name === "me") csrfToken = (result as { csrf_token: string }).csrf_token;
    if (name === "logout") csrfToken = undefined;
    return result;
  }

  return {
    async call<K extends CallableEndpoint>(name: K, ...args: CallArgs<K>): Promise<CallResult<K>> {
      return (await send(name, (args[0] ?? {}) as never)) as CallResult<K>;
    },
    /** The live event stream, for `new EventSource(url, { withCredentials: true })`. */
    eventsUrl(): string {
      return `${baseUrl}${endpoints.events.path}`;
    },
    /** Where a browser downloads a repository's runs or findings as CSV (a navigation, not a fetch). */
    exportUrl(
      repoId: string,
      query: { kind: "runs" | "findings"; from?: string; to?: string },
    ): string {
      const search = new URLSearchParams({ kind: query.kind });
      if (query.from) search.set("from", query.from);
      if (query.to) search.set("to", query.to);
      return `${baseUrl}/api/repos/${encodeURIComponent(repoId)}/export?${search}`;
    },
    /** Where to send the browser to start the sign-in (a navigation, not a fetch). */
    loginUrl(returnTo?: string): string {
      const query = returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : "";
      return `${baseUrl}${endpoints.login.path}${query}`;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
