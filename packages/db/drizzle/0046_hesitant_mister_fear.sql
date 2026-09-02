ALTER TABLE "feature_update_campaigns" ALTER COLUMN "target_build" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ALTER COLUMN "group_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ALTER COLUMN "offer_start_date_time_in_utc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ALTER COLUMN "offer_end_date_time_in_utc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ALTER COLUMN "offer_interval_in_days" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ADD COLUMN "assignments_new" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" ADD COLUMN "source" text DEFAULT 'intune' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "feature_update_campaigns_tenant_profile_idx" ON "feature_update_campaigns" USING btree ("tenant_id","intune_profile_id");--> statement-breakpoint
-- Hand-added backfill (not drizzle-kit generated): every row that exists at
-- this point predates the live-sync feature, so it was created exclusively by
-- PatchPilot's own campaign flow. Populate assignments_new from the old flat
-- group columns and mark provenance, ahead of the follow-up migration that
-- drops group_name/group_id/exclude_group_name/exclude_group_id and renames
-- assignments_new -> assignments.
UPDATE "feature_update_campaigns" SET "source" = 'patchpilot';--> statement-breakpoint
UPDATE "feature_update_campaigns"
SET "assignments_new" = (
  SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object('kind', 'include', 'groupId', "group_id", 'groupName', "group_name") AS entry
    WHERE "group_id" IS NOT NULL
    UNION ALL
    SELECT jsonb_build_object('kind', 'exclude', 'groupId', "exclude_group_id", 'groupName', "exclude_group_name") AS entry
    WHERE "exclude_group_id" IS NOT NULL
  ) sub
);