CREATE TABLE "device_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_group_id" uuid NOT NULL,
	"managed_device_id" text NOT NULL,
	"device_hostname" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
CREATE INDEX "device_group_members_group_idx" ON "device_group_members" USING btree ("device_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_group_members_unique_idx" ON "device_group_members" USING btree ("device_group_id","managed_device_id");--> statement-breakpoint
CREATE INDEX "device_groups_tenant_idx" ON "device_groups" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_groups_tenant_name_idx" ON "device_groups" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "jobs_batch_idx" ON "jobs" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "jobs_schedule_idx" ON "jobs" USING btree ("schedule_id");