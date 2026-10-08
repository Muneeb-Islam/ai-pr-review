// The audit view (PL-15, UI-08): who changed settings or credentials, re-ran or cancelled a review, and when.
import { InvalidCursorError, listAuditEntries } from "@ai-pr-review/db";
import { validationError } from "../http/errors";
import type { Handlers } from "../http/platform";

export const auditHandlers: Pick<Handlers, "listAuditLog"> = {
  async listAuditLog({ platform, installation, query }) {
    let page;
    try {
      page = await listAuditEntries(platform.db, [installation.id], {
        installationId: installation.id,
        ...(query.action ? { action: query.action } : {}),
        ...(query.cursor ? { cursor: query.cursor } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) throw validationError(["cursor: not a valid cursor"]);
      throw err;
    }
    return {
      items: page.items.map(({ entry, userLogin }) => ({
        id: entry.id,
        at: entry.at.toISOString(),
        user_login: userLogin,
        action: entry.action,
        target: entry.target,
        metadata: entry.metadata,
      })),
      next_cursor: page.nextCursor,
    };
  },
};
