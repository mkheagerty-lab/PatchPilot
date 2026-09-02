CREATE TABLE "device_vulnerabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"defender_machine_id" text NOT NULL,
	"cve_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "manufacturer" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "serial_number" text;--> statement-breakpoint
CREATE INDEX "device_vulns_tenant_machine_idx" ON "device_vulnerabilities" USING btree ("tenant_id","defender_machine_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_vulns_unique_idx" ON "device_vulnerabilities" USING btree ("tenant_id","defender_machine_id","cve_id");