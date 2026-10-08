import { appendAuditLog } from "@ai-pr-review/db";

/**
 * Records a settings, credential or run action (PL-15). `metadata` describes what changed by NAME (keys,
 * provider, scope); it must never carry values such as API keys.
 */
export async function audit(
  db: Parameters<typeof appendAuditLog>[0],
  installationId: string,
  userId: string,
  action: string,
  target: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await appendAuditLog(db, installationId, { userId, action, target, metadata });
}
