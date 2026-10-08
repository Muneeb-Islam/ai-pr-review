import { request } from "node:https";
import type { LookupFunction } from "node:net";
import { createSafeLookup } from "../net/ssrf";

export interface HttpRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body: string;
}

/** The seam adapters send requests through; tests replace it, so no test touches the network. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export type TransportErrorKind = "timeout" | "aborted" | "network" | "too_large";

/** A failure below HTTP. Carries no detail on purpose: the underlying messages can name hosts and addresses. */
export class TransportError extends Error {
  constructor(readonly kind: TransportErrorKind) {
    super(`transport ${kind}`);
    this.name = "TransportError";
  }
}

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * POSTs JSON over HTTPS with the SSRF guard applied at connection time (so DNS rebinding cannot reach an
 * internal address). The timeout covers the whole exchange, not only idle time; redirects are not followed.
 */
export function createHttpsTransport(
  options: { lookup?: LookupFunction; maxResponseBytes?: number } = {},
): Transport {
  const limit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return (req) =>
    new Promise<HttpResponse>((resolve, reject) => {
      if (req.signal?.aborted) return reject(new TransportError("aborted"));

      let settled = false;
      const onAbort = () => fail(new TransportError("aborted"));
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (err: TransportError) => {
        if (settled) return;
        cleanup();
        call.destroy();
        reject(err);
      };

      const timer = setTimeout(() => fail(new TransportError("timeout")), req.timeoutMs);
      const call = request(
        req.url,
        {
          method: "POST",
          headers: {
            ...req.headers,
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(req.body)),
          },
          lookup: options.lookup ?? (createSafeLookup() as unknown as LookupFunction),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) return fail(new TransportError("too_large"));
            chunks.push(chunk);
          });
          res.on("error", () => fail(new TransportError("network")));
          res.on("end", () => {
            if (settled) return;
            cleanup();
            const headers: Record<string, string | undefined> = {};
            for (const [name, value] of Object.entries(res.headers)) {
              headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
            }
            resolve({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      call.on("error", () => fail(new TransportError("network")));
      req.signal?.addEventListener("abort", onAbort, { once: true });
      call.end(req.body);
    });
}
