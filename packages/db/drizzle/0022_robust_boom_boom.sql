CREATE TABLE "missing_kbs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"kb_id" text NOT NULL,
	"title" text NOT NULL,
	"products" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cve_count" integer DEFAULT 0 NOT NULL,
	"url" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "kb_id" text;--> statement-breakpoint
CREATE INDEX "missing_kbs_tenant_device_idx" ON "missing_kbs" USING btree ("tenant_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "missing_kbs_unique_idx" ON "missing_kbs" USING btree ("device_id","kb_id");