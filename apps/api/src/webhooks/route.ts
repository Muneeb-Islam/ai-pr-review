import { verifyWebhookSignature } from "@ai-pr-review/core";
import type { Logger } from "@ai-pr-review/shared";
import type { FastifyError, FastifyInstance } from "fastify";
import type { WebhookService } from "./service";

export const WEBHOOK_PATH = "/webhooks/github";
export const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface WebhookRouteOptions {
  /** `GITHUB_WEBHOOK_SECRET`. */
  secret: string;
  service: WebhookService;
  logger: Logger;
  maxBodyBytes?: number;
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

const header = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * `POST /webhooks/github` (design §4, PL-02/PL-03):
 *
 *  1. read the RAW body (the signature covers the exact bytes, so JSON is parsed only afterwards);
 *  2. verify `X-Hub-Signature-256` in constant time: invalid or missing is 401 and nothing is created (AC-13);
 *  3. record `X-GitHub-Delivery`; a repeated ID is a no-op (AC-14);
 *  4. answer `202`; the handler runs in the background.
 */
export async function webhookRoutes(app: FastifyInstance, options: WebhookRouteOptions) {
  const { secret, service, logger } = options;
  const bodyLimit = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

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
        return reply.code(status).send(errorBody("bad_request", err.message));
      }
      logger.error("Webhook request failed", { error: err.name });
      return reply.code(500).send(errorBody("internal_error", "Internal error"));
    });

    scope.post(WEBHOOK_PATH, { bodyLimit }, async (request, reply) => {
      const raw = request.body as Buffer;
      if (!verifyWebhookSignature(secret, raw, header(request.headers["x-hub-signature-256"]))) {
        logger.warn("Webhook rejected: invalid signature");
        return reply.code(401).send(errorBody("invalid_signature", "Invalid webhook signature"));
      }

      const event = header(request.headers["x-github-event"]);
      const deliveryId = header(request.headers["x-github-delivery"]);
      if (!event || !deliveryId) {
        return reply
          .code(400)
          .send(errorBody("missing_headers", "X-GitHub-Event and X-GitHub-Delivery are required"));
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return reply.code(400).send(errorBody("invalid_json", "Body is not valid JSON"));
      }

      const status = await service.receive({ id: deliveryId, event, payload });
      return reply.code(202).send({ status });
    });
  });
}
