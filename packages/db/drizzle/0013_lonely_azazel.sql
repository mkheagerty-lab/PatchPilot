DROP INDEX "device_vulns_unique_idx";--> statement-breakpoint
DROP INDEX "vulns_tenant_cve_idx";--> statement-breakpoint
-- device_vulnerabilities is a sync-owned cache (delete-and-replaced every run),
-- so clearing it lets us add the NOT NULL software column on a populated table;
-- the next sync repopulates it at the new (machine, cve, software) grain.
DELETE FROM "device_vulnerabilities";--> statement-breakpoint
ALTER TABLE "device_vulnerabilities" ADD COLUMN "software" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "device_vulns_unique_idx" ON "device_vulnerabilities" USING btree ("tenant_id","defender_machine_id","cve_id","software");--> statement-breakpoint
CREATE UNIQUE INDEX "vulns_tenant_cve_idx" ON "vulnerabilities" USING btree ("tenant_id","cve_id","software");