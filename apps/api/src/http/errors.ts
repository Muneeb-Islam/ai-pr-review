// One error envelope for the whole API: `{ error: { code, message, request_id?, details? } }` (design §8).
import { randomUUID } from "node:crypto";
import type { Logger } from "@ai-pr-review/shared";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: string[],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const badRequest = (message: string, details?: string[]) =>
  new HttpError(400, "bad_request", message, details);
export const validationError = (details: string[]) =>
  new HttpError(400, "validation_error", "The request is not valid", details);
export const unauthorized = () => new HttpError(401, "unauthorized", "Sign in to continue");
export const forbidden = (message = "You do not have permission to do this") =>
  new HttpError(403, "forbidden", message);
/** Also the answer for another tenant's resource: it must be indistinguishable from "does not exist". */
export const notFound = () => new HttpError(404, "not_found", "Not found");
/** The request is fine but the resource is in a state that does not allow it (a closed pull request, a finished run). */
export const conflict = (code: string, message: string) => new HttpError(409, code, message);
/** GitHub did not answer a call the request depended on. */
export const badGateway = (message: string) => new HttpError(502, "github_unavailable", message);
export const unavailable = (message: string) => new HttpError(503, "unavailable", message);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new HttpError(429, "rate_limited", "Too many requests; try again shortly", undefined, {
    "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
  });

export const errorBody = (
  code: string,
  message: string,
  requestId?: string,
  details?: string[],
) => ({
  error: {
    code,
    message,
    ...(requestId ? { request_id: requestId } : {}),
    ...(details && details.length > 0 ? { details } : {}),
  },
});

/** Fixed texts for framework-level 4xx errors. The framework's own message is never echoed (it can quote the body). */
const FRAMEWORK_MESSAGES: Record<number, [string, string]> = {
  400: ["bad_request", "The request could not be understood"],
  404: ["not_found", "Not found"],
  413: ["payload_too_large", "The request body is too large"],
  415: ["unsupported_media_type", "Unsupported media type"],
};

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Takes a caller-supplied request id when it is harmless, else makes one. */
export function newRequestId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return value && REQUEST_ID.test(value) ? value : randomUUID();
}

export function installErrorHandling(app: FastifyInstance, logger: Logger): void {
  app.setErrorHandler(
    (error: FastifyError | HttpError, request: FastifyRequest, reply: FastifyReply) => {
      if (error instanceof HttpError) {
        for (const [name, value] of Object.entries(error.headers ?? {})) reply.header(name, value);
        return reply
          .code(error.status)
          .send(errorBody(error.code, error.message, request.id, error.details));
      }
      const status = (error as FastifyError).statusCode;
      if (status && status >= 400 && status < 500) {
        const invalidJson =
          error instanceof SyntaxError ||
          (error as FastifyError).code === "FST_ERR_CTP_INVALID_JSON_BODY";
        const [code, message] = FRAMEWORK_MESSAGES[status] ?? FRAMEWORK_MESSAGES[400]!;
        return reply
          .code(status)
          .send(
            errorBody(
              invalidJson ? "bad_request" : code,
              invalidJson ? "The request body is not valid JSON" : message,
              request.id,
            ),
          );
      }
      // Names only: error messages from the database or GitHub clients can contain query text or tokens.
      logger.error("Request failed", { request: request.id, error: error.name });
      return reply.code(500).send(errorBody("internal_error", "Internal error", request.id));
    },
  );

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(errorBody("not_found", "Not found", request.id)),
  );
}
