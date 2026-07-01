ALTER TABLE "blocked_times_series" ADD COLUMN "resource_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- MULTI-CAGE backfill: existing (migration 0040) single-cage series get their
-- one resource copied into the new full-set column so edit/regenerate keeps
-- covering the same cage.
UPDATE "blocked_times_series" SET "resource_ids" = ARRAY["resource_id"] WHERE "resource_ids" = '{}';