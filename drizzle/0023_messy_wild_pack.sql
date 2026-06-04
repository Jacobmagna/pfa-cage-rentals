CREATE TYPE "public"."enrollment_cap_period" AS ENUM('week', 'month', 'total');--> statement-breakpoint
ALTER TABLE "athlete_programs" ADD COLUMN "cap" integer;--> statement-breakpoint
ALTER TABLE "athlete_programs" ADD COLUMN "cap_period" "enrollment_cap_period";--> statement-breakpoint

-- Raw-SQL CHECK constraint (Drizzle Kit can't generate CHECK). Same
-- approach as programs_cap_period_co_required in migration 0015.
-- athlete_programs.cap and .cap_period are co-required: both NULL (no
-- cap) or both NOT NULL. ((a IS NULL) = (b IS NULL)) is TRUE in both the
-- co-present and co-absent cases, FALSE when exactly one side is set.
ALTER TABLE "athlete_programs" ADD CONSTRAINT "athlete_programs_cap_corequired" CHECK (("athlete_programs"."cap" IS NULL) = ("athlete_programs"."cap_period" IS NULL));
