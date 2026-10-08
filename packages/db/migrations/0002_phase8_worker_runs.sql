ALTER TABLE "review_runs" ADD COLUMN "skipped_files" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "heartbeat_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "review_runs" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_run_agent_uq" ON "agent_runs" USING btree ("run_id","agent");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_run_agent_fingerprint_uq" ON "findings" USING btree ("run_id","agent","fingerprint") WHERE "findings"."suppressed_reason" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "findings_run_agent_fingerprint_suppressed_uq" ON "findings" USING btree ("run_id","agent","fingerprint","suppressed_reason") WHERE "findings"."suppressed_reason" is not null;--> statement-breakpoint
CREATE INDEX "review_runs_running_heartbeat_idx" ON "review_runs" USING btree ("heartbeat_at") WHERE "review_runs"."status" = 'running';