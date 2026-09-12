ALTER TABLE "container_stats" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "container_stats" ADD COLUMN "disk_size" text;--> statement-breakpoint
ALTER TABLE "container_stats" ADD COLUMN "health" text;--> statement-breakpoint
ALTER TABLE "container_stats" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "container_stats" ADD COLUMN "restart_count" integer;