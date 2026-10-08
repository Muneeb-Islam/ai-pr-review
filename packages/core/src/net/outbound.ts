import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { createSafeLookup } from "./ssrf";

export interface OutboundResponse {
  status: number;
}

/**
 * One HTTPS request to a user-supplied host, with the SSRF guard applied at connection time. Redirects are not
 * followed and the body is discarded: callers only learn the status. Rejects on timeout or a blocked address.
 */
export function httpsStatus(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    timeoutMs: number;
    /** Test seam; defaults to the system resolver behind the address guard. */
    lookup?: LookupFunction;
  },
): Promise<OutboundResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        lookup: options.lookup ?? (createSafeLookup() as unknown as LookupFunction),
        timeout: options.timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end();
  });
}
