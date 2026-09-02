CREATE TABLE "cve_catalog" (
	"cve_id" text PRIMARY KEY NOT NULL,
	"name" text,
	"description" text,
	"severity" text,
	"cvss_v3" double precision,
	"cvss_vector" text,
	"published_on" timestamp with time zone,
	"updated_on" timestamp with time zone,
	"epss" double precision,
	"public_exploit" boolean DEFAULT false NOT NULL,
	"exploit_verified" boolean DEFAULT false NOT NULL,
	"exploit_in_kit" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
