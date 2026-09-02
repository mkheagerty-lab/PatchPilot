ALTER TABLE "winget_catalog" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "winget_catalog" ADD COLUMN "last_refreshed_at" timestamp with time zone;