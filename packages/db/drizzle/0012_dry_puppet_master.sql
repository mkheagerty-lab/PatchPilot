ALTER TABLE "device_vulnerabilities" ADD COLUMN "software_version" text;--> statement-breakpoint
ALTER TABLE "device_vulnerabilities" ADD COLUMN "disk_paths" jsonb;