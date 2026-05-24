CREATE TABLE "coach_rate_overrides" (
	"coach_id" text NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"rate_per_30_min_cents" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coach_rate_overrides_coach_id_resource_type_pk" PRIMARY KEY("coach_id","resource_type")
);
--> statement-breakpoint
ALTER TABLE "coach_rate_overrides" ADD CONSTRAINT "coach_rate_overrides_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;