ALTER TABLE "engineers" ADD COLUMN "entra_object_id" text;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "read_only_group_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "write_access_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "engineers" ADD COLUMN "write_group_synced_at" timestamp with time zone;