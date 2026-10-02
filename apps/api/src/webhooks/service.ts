import {
  markWebhookDeliveryProcessed,
  reclaimFailedWebhookDelivery,
  recordWebhookDelivery,
  WEBHOOK_OUTCOME_ERROR,
} from "@ai-pr-review/db/system";
import type { ZodType } from "zod";
import { handleInstallation, handleInstallationRepositories } from "./installations";
import {
  checkRunEvent,
  installationEvent,
  installationRepositoriesEvent,
  issueCommentEvent,
  pullRequestEvent,
} from "./payloads";
import { handleCheckRun, handleIssueComment, handlePullRequest } from "./pullRequests";
import { ignored, type HandlerResult, type WebhookDeps } from "./types";

export interface Delivery {
  /** `X-GitHub-Delivery` */
  id: string;
  /** `X-GitHub-Event` */
  event: string;
  payload: unknown;
}

type Handler<T> = (deps: WebhookDeps, event: T) => Promise<HandlerResult>;

/** Binds an event name to its payload schema and handler. */
function route<T>(schema: ZodType<T>, handler: Handler<T>) {
  return async (
    deps: WebhookDeps,
    payload: unknown,
    deliveryId: string,
  ): Promise<HandlerResult> => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      // A signed payload of an unexpected shape: record and move on; never throw into GitHub's retry loop.
      deps.logger.warn("Unexpected webhook payload shape", { delivery: deliveryId });
      return ignored("invalid_payload");
    }
    return handler(deps, parsed.data);
  };
}

const HANDLERS: Record<
  string,
  (deps: WebhookDeps, payload: unknown, deliveryId: string) => Promise<HandlerResult>
> = {
  installation: route(installationEvent, handleInstallation),
  installation_repositories: route(installationRepositoriesEvent, handleInstallationRepositories),
  pull_request: route(pullRequestEvent, handlePullRequest),
  issue_comment: route(issueCommentEvent, handleIssueComment),
  check_run: route(checkRunEvent, handleCheckRun),
};

export type ReceiveResult = "accepted" | "duplicate";

/**
 * Webhook processing (design §7). `receive` records the delivery and returns, so the route can answer
 * `202` at once; the handler then runs in the background. Handlers are idempotent: redelivery of a delivery
 * that completed is a no-op (AC-14), while one whose processing failed is processed again.
 */
export class WebhookService {
  private readonly inflight = new Set<Promise<void>>();

  constructor(private readonly deps: WebhookDeps) {}

  async receive(delivery: Delivery): Promise<ReceiveResult> {
    const { db } = this.deps;
    const { firstSeen } = await recordWebhookDelivery(db, {
      deliveryId: delivery.id,
      event: delivery.event,
    });
    if (!firstSeen && !(await reclaimFailedWebhookDelivery(db, delivery.id))) {
      return "duplicate";
    }

    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.process(delivery))
      .then(() => undefined)
      .finally(() => this.inflight.delete(task));
    this.inflight.add(task);
    return "accepted";
  }

  /** Resolves when every delivery accepted so far has been processed (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** Runs the handler and records the outcome. Never throws. */
  async process(delivery: Delivery): Promise<string> {
    const log = this.deps.logger.child({ delivery: delivery.id, event: delivery.event });
    try {
      const handler = HANDLERS[delivery.event];
      const result: HandlerResult = handler
        ? await handler(this.deps, delivery.payload, delivery.id)
        : ignored(delivery.event === "ping" ? "ping" : "unsupported_event");
      await markWebhookDeliveryProcessed(this.deps.db, delivery.id, result.outcome, {
        ...(result.installationId ? { installationId: result.installationId } : {}),
      });
      log.info("Webhook processed", { outcome: result.outcome });
      return result.outcome;
    } catch (err) {
      // Log the error type only: messages from drivers can echo query parameters.
      log.error("Webhook processing failed", {
        error: err instanceof Error ? err.name : "unknown",
      });
      try {
        // Recorded as an error so GitHub's redelivery of this delivery is processed again.
        await markWebhookDeliveryProcessed(this.deps.db, delivery.id, WEBHOOK_OUTCOME_ERROR);
      } catch {
        log.error("Could not record the webhook failure");
      }
      return WEBHOOK_OUTCOME_ERROR;
    }
  }
}
