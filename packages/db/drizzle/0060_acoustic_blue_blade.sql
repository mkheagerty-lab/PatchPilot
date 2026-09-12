CREATE TABLE "container_stats" (
	"container" text PRIMARY KEY NOT NULL,
	"cpu_percent" double precision NOT NULL,
	"mem_usage" text NOT NULL,
	"net_io" text NOT NULL,
	"block_io" text NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL
);
