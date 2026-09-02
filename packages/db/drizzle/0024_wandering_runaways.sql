ALTER TABLE "recommendations" ADD COLUMN "os_platform" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "sub_category" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "related_component" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "exposure_impact" double precision;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "config_score_impact" double precision;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "active_alert" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "associated_threats" jsonb DEFAULT '[]'::jsonb NOT NULL;