CREATE TYPE "public"."account_type" AS ENUM('user', 'organization');--> statement-breakpoint
CREATE TYPE "public"."agent_id" AS ENUM('code_review', 'test_coverage', 'security', 'final_review');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('ok', 'failed', 'timeout', 'invalid_output');--> statement-breakpoint
CREATE TYPE "public"."category" AS ENUM('bug', 'security', 'test_gap', 'performance', 'maintainability');--> statement-breakpoint
CREATE TYPE "public"."feedback_verdict" AS ENUM('useful', 'false_positive', 'known');--> statement-breakpoint
CREATE TYPE "public"."installation_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."installation_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."posted_comment_kind" AS ENUM('review_comment', 'summary', 'check');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('anthropic', 'openai', 'deepseek');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'completed', 'partial', 'failed', 'skipped', 'superseded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('pull_request', 'comment_command', 'check_run_rerequested', 'dashboard_rerun');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."suppress_reason" AS ENUM('below_threshold', 'invalid_line', 'no_evidence', 'duplicate', 'style_only', 'rejected_by_final_review');--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"agent" "agent_id" NOT NULL,
	"status" "agent_run_status" NOT NULL,
	"started_at" timestamp (3) with time zone,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_feedback" (
	"finding_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"verdict" "feedback_verdict" NOT NULL,
	"note" varchar(1000),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "finding_feedback_finding_id_user_id_pk" PRIMARY KEY("finding_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"agent" "agent_id" NOT NULL,
	"category" "category" NOT NULL,
	"severity" "severity" NOT NULL,
	"confidence" real NOT NULL,
	"title" text NOT NULL,
	"file_path" text,
	"start_line" integer,
	"end_line" integer,
	"evidence" varchar(500) NOT NULL,
	"impact" text NOT NULL,
	"recommendation" text NOT NULL,
	"suggested_test" text,
	"fingerprint" text NOT NULL,
	"posted" boolean DEFAULT false NOT NULL,
	"suppressed_reason" "suppress_reason",
	CONSTRAINT "findings_installation_id_id_uq" UNIQUE("installation_id","id"),
	CONSTRAINT "findings_confidence_range" CHECK ("findings"."confidence" >= 0 and "findings"."confidence" <= 1),
	CONSTRAINT "findings_start_line_positive" CHECK ("findings"."start_line" is null or "findings"."start_line" > 0),
	CONSTRAINT "findings_end_line_not_before_start" CHECK ("findings"."end_line" is null or "findings"."start_line" is null or "findings"."end_line" >= "findings"."start_line"),
	CONSTRAINT "findings_suppressed_not_posted" CHECK ("findings"."suppressed_reason" is null or not "findings"."posted")
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"account_login" text NOT NULL,
	"account_type" "account_type" NOT NULL,
	"status" "installation_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installations_github_installation_id_unique" UNIQUE("github_installation_id")
);
--> statement-breakpoint
CREATE TABLE "posted_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "posted_comment_kind" NOT NULL,
	"github_id" bigint NOT NULL,
	"fingerprint" text,
	"head_sha" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo_id" uuid,
	"provider" "provider" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"last4" varchar(4) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_settings" (
	"repo_id" uuid PRIMARY KEY NOT NULL,
	"installation_id" uuid NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"is_private" boolean NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "repositories_installation_id_id_uq" UNIQUE("installation_id","id")
);
--> statement-breakpoint
CREATE TABLE "review_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"base_sha" text NOT NULL,
	"base_ref" text NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"triggered_by" text,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"status_reason" text,
	"check_run_id" bigint,
	"summary_comment_id" bigint,
	"queued_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"parent_run_id" uuid,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0}'::jsonb NOT NULL,
	CONSTRAINT "review_runs_installation_id_id_uq" UNIQUE("installation_id","id"),
	CONSTRAINT "review_runs_finished_at_matches_status" CHECK (("review_runs"."status" in ('queued', 'running')) = ("review_runs"."finished_at" is null)),
	CONSTRAINT "review_runs_running_has_started_at" CHECK ("review_runs"."status" <> 'running' or "review_runs"."started_at" is not null),
	CONSTRAINT "review_runs_pr_number_positive" CHECK ("review_runs"."pr_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"csrf_secret" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_installations" (
	"user_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"role" "installation_role" NOT NULL,
	"refreshed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_installations_user_id_installation_id_pk" PRIMARY KEY("user_id","installation_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"github_user_id" bigint NOT NULL,
	"login" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event" text NOT NULL,
	"installation_id" uuid,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp (3) with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_run_fk" FOREIGN KEY ("installation_id","run_id") REFERENCES "public"."review_runs"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_feedback" ADD CONSTRAINT "finding_feedback_finding_fk" FOREIGN KEY ("installation_id","finding_id") REFERENCES "public"."findings"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_fk" FOREIGN KEY ("installation_id","run_id") REFERENCES "public"."review_runs"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_repo_fk" FOREIGN KEY ("installation_id","repo_id") REFERENCES "public"."repositories"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posted_comments" ADD CONSTRAINT "posted_comments_run_fk" FOREIGN KEY ("installation_id","run_id") REFERENCES "public"."review_runs"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_repo_fk" FOREIGN KEY ("installation_id","repo_id") REFERENCES "public"."repositories"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD CONSTRAINT "repo_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD CONSTRAINT "repo_settings_repo_fk" FOREIGN KEY ("installation_id","repo_id") REFERENCES "public"."repositories"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_parent_run_id_review_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."review_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_runs" ADD CONSTRAINT "review_runs_repo_fk" FOREIGN KEY ("installation_id","repo_id") REFERENCES "public"."repositories"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installations" ADD CONSTRAINT "user_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installations" ADD CONSTRAINT "user_installations_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_run_id_idx" ON "agent_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "audit_log_installation_at_idx" ON "audit_log" USING btree ("installation_id","at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "finding_feedback_installation_idx" ON "finding_feedback" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "findings_run_id_idx" ON "findings" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "findings_repo_severity_idx" ON "findings" USING btree ("repo_id","severity");--> statement-breakpoint
CREATE INDEX "posted_comments_run_id_idx" ON "posted_comments" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "posted_comments_fingerprint_sha_idx" ON "posted_comments" USING btree ("fingerprint","head_sha");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_installation_provider_uq" ON "provider_credentials" USING btree ("installation_id","provider") WHERE "provider_credentials"."repo_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_credentials_repo_provider_uq" ON "provider_credentials" USING btree ("repo_id","provider") WHERE "provider_credentials"."repo_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_installation_github_repo_uq" ON "repositories" USING btree ("installation_id","github_repo_id");--> statement-breakpoint
CREATE INDEX "repositories_installation_full_name_idx" ON "repositories" USING btree ("installation_id","full_name");--> statement-breakpoint
CREATE INDEX "review_runs_repo_queued_idx" ON "review_runs" USING btree ("repo_id","queued_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "review_runs_status_idx" ON "review_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "review_runs_repo_pr_head_idx" ON "review_runs" USING btree ("repo_id","pr_number","head_sha");--> statement-breakpoint
CREATE INDEX "review_runs_installation_queued_idx" ON "review_runs" USING btree ("installation_id","queued_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "review_runs_active_idx" ON "review_runs" USING btree ("installation_id","queued_at") WHERE "review_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "user_installations_installation_id_idx" ON "user_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_received_at_idx" ON "webhook_deliveries" USING btree ("received_at");