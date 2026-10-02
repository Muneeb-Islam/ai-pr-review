import { and, eq } from "drizzle-orm";
import type { Database } from "../client";
import { webhookDeliveries } from "../schema";

export interface WebhookDeliveryInput {
  /** `X-GitHub-Delivery`. */
  deliveryId: string;
  event: string;
  /** Known once the payload is matched to an installation. */
  installationId?: string;
  receivedAt?: Date;
}

/**
 * Records a delivery. Returns `firstSeen: false` if this delivery ID was seen before, so a redelivery is
 * processed once (PL-03, AC-14). The check and the insert are one atomic statement.
 */
export async function recordWebhookDelivery(
  db: Database,
  input: WebhookDeliveryInput,
): Promise<{ firstSeen: boolean }> {
  const rows = await db
    .insert(webhookDeliveries)
    .values({
      deliveryId: input.deliveryId,
      event: input.event,
      installationId: input.installationId ?? null,
      ...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
    })
    .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return { firstSeen: rows.length > 0 };
}

export async function markWebhookDeliveryProcessed(
  db: Database,
  deliveryId: string,
  outcome: string,
  options: { installationId?: string; at?: Date } = {},
): Promise<boolean> {
  const rows = await db
    .update(webhookDeliveries)
    .set({
      processedAt: options.at ?? new Date(),
      outcome,
      ...(options.installationId ? { installationId: options.installationId } : {}),
    })
    .where(eq(webhookDeliveries.deliveryId, deliveryId))
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return rows.length > 0;
}

export const WEBHOOK_OUTCOME_ERROR = "error";

/**
 * Takes over a delivery whose processing failed (`outcome = 'error'`) so GitHub's redelivery of the same
 * delivery ID is processed again instead of being swallowed as a duplicate. One atomic UPDATE: of several
 * concurrent redeliveries exactly one gets `true`. A delivery that succeeded, was ignored or is still being
 * processed is never reclaimed.
 */
export async function reclaimFailedWebhookDelivery(
  db: Database,
  deliveryId: string,
): Promise<boolean> {
  const rows = await db
    .update(webhookDeliveries)
    .set({ processedAt: null, outcome: null })
    .where(
      and(
        eq(webhookDeliveries.deliveryId, deliveryId),
        eq(webhookDeliveries.outcome, WEBHOOK_OUTCOME_ERROR),
      ),
    )
    .returning({ deliveryId: webhookDeliveries.deliveryId });
  return rows.length > 0;
}

export async function getWebhookDelivery(db: Database, deliveryId: string) {
  const [row] = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.deliveryId, deliveryId));
  return row;
}
