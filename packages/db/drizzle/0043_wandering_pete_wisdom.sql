ALTER TYPE "public"."channel" ADD VALUE 'expedited-feature-update';--> statement-breakpoint
CREATE TABLE "feature_update_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"display_name" text NOT NULL,
	"target_version" text NOT NULL,
	"target_build" integer NOT NULL,
	"group_name" text NOT NULL,
	"group_id" text NOT NULL,
	"intune_profile_id" text NOT NULL,
	"offer_start_date_time_in_utc" timestamp with time zone NOT NULL,
	"offer_end_date_time_in_utc" timestamp with time zone NOT NULL,
	"offer_interval_in_days" integer NOT NULL,
	"install_feature_updates_optional" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "os_build" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "feature_update_version" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "feature_update_target_version" text;--> statement-breakpoint
CREATE INDEX "feature_update_campaigns_tenant_idx" ON "feature_update_campaigns" USING btree ("tenant_id");