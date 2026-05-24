CREATE TABLE "rate_defaults" (
	"type" "resource_type" PRIMARY KEY NOT NULL,
	"rate_per_30_min_cents" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
