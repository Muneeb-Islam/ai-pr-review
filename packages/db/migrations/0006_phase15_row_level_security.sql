-- Row-level security as defence in depth for tenant data (design §9, Phase 15).
--
-- A row is visible and writable when the session says so, in one of two ways:
--   * `aipr.scope = 'system'`        the worker, webhook handlers and scheduled jobs (unscoped by design);
--   * `aipr.installation_ids = '..'` a comma-separated list of installation ids, set per transaction with
--                                    set_config(..., true) for the dashboard API: the signed-in user's installations.
-- With neither setting a session sees nothing, so a query that forgets its scope returns no rows instead of
-- another tenant's. Policies apply to every role that is neither a superuser nor has BYPASSRLS and does not
-- own the table: run the api and the worker as a separate, plain role (docs/operations.md) and keep the
-- owner role for migrations. Superusers bypass row-level security entirely.
CREATE FUNCTION "aipr_scope_allows"(installation uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT current_setting('aipr.scope', true) = 'system'
        OR installation = ANY (string_to_array(nullif(current_setting('aipr.installation_ids', true), ''), ',')::uuid[])
  $$;--> statement-breakpoint
ALTER TABLE "installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "installations" USING ("aipr_scope_allows"("id")) WITH CHECK ("aipr_scope_allows"("id"));--> statement-breakpoint
ALTER TABLE "repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "repositories" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "installation_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "installation_settings" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "repo_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "repo_settings" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "provider_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "provider_credentials" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "review_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "review_runs" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "agent_runs" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "findings" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "posted_comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "posted_comments" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "finding_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "finding_feedback" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "audit_log" USING ("aipr_scope_allows"("installation_id")) WITH CHECK ("aipr_scope_allows"("installation_id"));
