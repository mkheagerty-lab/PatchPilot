ALTER TABLE "vulnerabilities" ADD COLUMN "cvss_vector" text;--> statement-breakpoint
ALTER TABLE "vulnerabilities" ADD COLUMN "epss" double precision;--> statement-breakpoint
ALTER TABLE "vulnerabilities" ADD COLUMN "published_on" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vulnerabilities" ADD COLUMN "updated_on" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vulnerabilities" ADD COLUMN "exploit_available" boolean DEFAULT false NOT NULL;