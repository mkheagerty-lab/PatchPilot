CREATE TYPE "public"."quality_update_policy_type" AS ENUM('expedite', 'quality-update');--> statement-breakpoint
CREATE TABLE "driver_update_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"intune_profile_id" text NOT NULL,
	"display_name" text NOT NULL,
	"assignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_type" text,
	"deployment_deferral_in_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "update_ring_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"intune_profile_id" text NOT NULL,
	"display_name" text NOT NULL,
	"assignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quality_updates_deferral_period_in_days" integer,
	"feature_updates_deferral_period_in_days" integer,
	"allow_windows_11_upgrade" boolean,
	"automatic_update_mode" text,
	"business_ready_updates_only" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ALTER COLUMN "kb_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ALTER COLUMN "catalog_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ALTER COLUMN "release_label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ALTER COLUMN "days_until_forced_reboot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ALTER COLUMN "group_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ADD COLUMN "policy_type" "quality_update_policy_type" DEFAULT 'expedite' NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ADD COLUMN "assignments" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" ADD COLUMN "source" text DEFAULT 'intune' NOT NULL;--> statement-breakpoint
CREATE INDEX "driver_update_profiles_tenant_idx" ON "driver_update_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "driver_update_profiles_tenant_profile_idx" ON "driver_update_profiles" USING btree ("tenant_id","intune_profile_id");--> statement-breakpoint
CREATE INDEX "update_ring_profiles_tenant_idx" ON "update_ring_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "update_ring_profiles_tenant_profile_idx" ON "update_ring_profiles" USING btree ("tenant_id","intune_profile_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_update_campaigns_tenant_policy_profile_idx" ON "quality_update_campaigns" USING btree ("tenant_id","policy_type","intune_profile_id");--> statement-breakpoint
-- Hand-added backfill (not drizzle-kit generated): every row that exists at
-- this point predates this rework, so it's unambiguously an expedite policy
-- PatchPilot itself created (policy_type already defaults to 'expedite').
-- Populate assignments from the old flat group columns and mark provenance,
-- ahead of the follow-up migration that drops group_name/group_id/
-- exclude_group_name/exclude_group_id — same two-step precedent as
-- 0046_hesitant_mister_fear.sql / 0047_feature_update_campaigns_finalize.sql.
UPDATE "quality_update_campaigns" SET "source" = 'patchpilot';--> statement-breakpoint
UPDATE "quality_update_campaigns"
SET "assignments" = (
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object('kind', 'include', 'groupId', "group_id", 'groupName', "group_name") AS entry
    WHERE "group_id" IS NOT NULL
    UNION ALL
    SELECT jsonb_build_object('kind', 'exclude', 'groupId', "exclude_group_id", 'groupName', "exclude_group_name") AS entry
    WHERE "exclude_group_id" IS NOT NULL
  ) sub
);