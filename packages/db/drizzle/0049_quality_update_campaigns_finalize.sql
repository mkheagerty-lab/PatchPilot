-- Custom SQL migration file, put your code below! --
ALTER TABLE "quality_update_campaigns" DROP COLUMN "group_name";--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" DROP COLUMN "group_id";--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" DROP COLUMN "exclude_group_name";--> statement-breakpoint
ALTER TABLE "quality_update_campaigns" DROP COLUMN "exclude_group_id";
