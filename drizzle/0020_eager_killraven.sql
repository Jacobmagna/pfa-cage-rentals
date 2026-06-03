CREATE TABLE "program_rate_overrides" (
	"coach_id" text NOT NULL,
	"program_id" text NOT NULL,
	"rate_per_30_min_cents" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "program_rate_overrides_coach_id_program_id_pk" PRIMARY KEY("coach_id","program_id")
);
--> statement-breakpoint
ALTER TABLE "hour_logs" ADD COLUMN "rate_per_30_min_cents" integer;--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "default_rate_per_30_min_cents" integer;--> statement-breakpoint
ALTER TABLE "program_rate_overrides" ADD CONSTRAINT "program_rate_overrides_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_rate_overrides" ADD CONSTRAINT "program_rate_overrides_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;