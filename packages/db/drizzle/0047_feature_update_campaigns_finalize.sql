-- Custom SQL migration file, put your code below! --
ALTER TABLE "feature_update_campaigns" RENAME COLUMN "assignments_new" TO "assignments";--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" DROP COLUMN "group_name";--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" DROP COLUMN "group_id";--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" DROP COLUMN "exclude_group_name";--> statement-breakpoint
ALTER TABLE "feature_update_campaigns" DROP COLUMN "exclude_group_id";
