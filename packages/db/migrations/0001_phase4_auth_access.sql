CREATE TABLE "installation_settings" (
	"installation_id" uuid PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_repositories" (
	"user_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"role" "installation_role" NOT NULL,
	"refreshed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_repositories_user_id_repo_id_pk" PRIMARY KEY("user_id","repo_id")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_installation_id_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_settings" ADD CONSTRAINT "installation_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_repositories" ADD CONSTRAINT "user_repositories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_repositories" ADD CONSTRAINT "user_repositories_repo_fk" FOREIGN KEY ("installation_id","repo_id") REFERENCES "public"."repositories"("installation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_repositories_repo_id_idx" ON "user_repositories" USING btree ("repo_id");