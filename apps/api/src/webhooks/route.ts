import { verifyWebhookSignature } from "@ai-pr-review/core";
import type { Logger } from "@ai-pr-review/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import type { RateLimiter } from "../http/rateLimit";
import type { ApiMetrics } from "../metrics/registry";
import type { WebhookService } from "./service";

export const WEBHOOK_PATH = "/webhooks/github";
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Abuse limits of the webhook endpoint (Phase 15, AC-23). Fixed one-minute windows, shared through Redis. */
export interface WebhookLimits {
  limiter: RateLimiter;
  /** Requests per client IP. GitHub delivers from a few addresses, so this is generous. */
  perIpPerMinute: number;
  /** Requests with a missing or wrong signature per client IP: forgery and probing. */
  badSignaturePerMinute: number;
  /** Events per installation: one account cannot flood the queue with a storm of pushes. */
  perInstallationPerMinute: number;
}

export interface WebhookRouteOptions {
  /** `GITHUB_WEBHOOK_SECRET`. */
  secret: string;
  service: WebhookService;
  logger: Logger;
  maxBodyBytes?: number;
  /** Without it nothing is rate limited (tests of other things). */
  limits?: WebhookLimits;
  metrics?: ApiMetrics;
}

const MINUTE_MS = 60_000;

const errorBody = (code: string, message: string) => ({ error: { code, message } });

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** The installation id a payload names, read without trusting its shape (the schema check comes later). */
function installationIdOf(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const installation = (payload as { installation?: unknown }).installation;
  if (typeof installation !== "object" || installation === null) return undefined;
  const id = (installation as { id?: unknown }).id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : undefined;
}

/**
 * `POST /webhooks/github` (design §4, PL-02/PL-03):
 *
 *  0. rate limit by client address (Phase 15), before any work is done;
 *  1. read the RAW body (the signature covers the exact bytes, so JSON is parsed only afterwards);
 *  2. verify `X-Hub-Signature-256` in constant time: invalid or missing is 401 and nothing is created (AC-13);
 *  3. limit the events one installation may cause per minute (429, delivery not recorded);
 *  4. record `X-GitHub-Delivery`; a repeated ID is a no-op (AC-14);
 *  5. answer `202`; the handler runs in the background.
 */
export async function webhookRoutes(app: FastifyInstance, options: WebhookRouteOptions) {
  const { secret, service, logger, limits, metrics } = options;
  const bodyLimit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const count = (result: string) => metrics?.webhooks.inc({ result });

  // Encapsulated: only this plugin hands out raw bodies, so later JSON routes keep the normal parser.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit },
      (_request, body, done) => done(null, body),
    );

    scope.setErrorHandler((error, _request, reply) => {
      const err = error as FastifyError;
      const status = err.statusCode;
      if (status && status >= 400 && status < 500) {
        // Body too large (413), unsupported media type (415): safe, generic client errors.
        count("bad_request");
        return reply.code(status).send(errorBody("bad_request", err.message));
      }
      logger.error("Webhook request failed", { error: err.name });
      return reply.code(500).send(errorBody("internal_error", "Internal error"));
    });

    scope.post(WEBHOOK_PATH, { bodyLimit }, async (request, reply) => {
      const tooMany = (retryAfterSeconds: number, code: string) =>
        reply
          .code(429)
          .header("retry-after", String(Math.max(1, retryAfterSeconds)))
          .send(errorBody(code, "Too many webhook requests; try again shortly"));

      // The cheapest check first: a flood from one address never reaches the HMAC, the database or the queue.
      if (limits) {
        const hit = await limits.limiter.hit(
          `webhook:ip:${request.ip}`,
          limits.perIpPerMinute,
          MINUTE_MS,
        );
        if (!hit.allowed) {
          count("rate_limited");
          return tooMany(hit.retryAfterSeconds, "rate_limited");
        }
      }

      const raw = request.body as Buffer;
      if (!verifyWebhookSignature(secret, raw, header(request.headers["x-hub-signature-256"]))) {
        count("invalid_signature");
        // Forgery attempts are counted on their own and answered 429 past the limit, so a prober is told to stop.
        if (limits) {
          const bad = await limits.limiter.hit(
            `webhook:bad:${request.ip}`,
            limits.badSignaturePerMinute,
            MINUTE_MS,
          );
          if (!bad.allowed) {
            logger.warn("Webhook rejected: too many invalid signatures from one address");
            return tooMany(bad.retryAfterSeconds, "rate_limited");
          }
        }
        logger.warn("Webhook rejected: invalid signature");
        return reply.code(401).send(errorBody("invalid_signature", "Invalid webhook signature"));
      }

      const event = header(request.headers["x-github-event"]);
      const deliveryId = header(request.headers["x-github-delivery"]);
      if (!event || !deliveryId) {
        count("bad_request");
        return reply
          .code(400)
          .send(errorBody("missing_headers", "X-GitHub-Event and X-GitHub-Delivery are required"));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        count("bad_request");
        return reply.code(400).send(errorBody("invalid_json", "Body is not valid JSON"));
      }

      // Signed by GitHub, so the installation named here is real: one account's storm cannot use up everyone's
      // capacity. The delivery is not recorded, so redelivering it later (from GitHub's UI) still works.
      const installation = installationIdOf(payload);
      if (limits && installation !== undefined) {
        const hit = await limits.limiter.hit(
          `webhook:installation:${installation}`,
          limits.perInstallationPerMinute,
          MINUTE_MS,
        );
        if (!hit.allowed) {
          count("installation_rate_limited");
          logger.warn("Webhook rejected: installation rate limit", { installation });
          return tooMany(hit.retryAfterSeconds, "installation_rate_limited");
        }
      }

      const status = await service.receive({ id: deliveryId, event, payload });
      count(status);
      return reply.code(202).send({ status });
    });
  });
}
