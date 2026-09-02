CREATE TABLE "manual_remediations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"cve_id" text,
	"software" text NOT NULL,
	"notes" text NOT NULL,
	"engineer" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "script_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"description" text,
	"script_content" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "manual_remediations_tenant_device_idx" ON "manual_remediations" USING btree ("tenant_id","device_id");