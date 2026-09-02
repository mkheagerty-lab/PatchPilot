ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "schedule_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;