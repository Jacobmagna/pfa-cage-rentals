-- Auto-generated to sync Drizzle's snapshot with reality after the
-- indexes were added by hand in 0004's raw-SQL section. Without these
-- rows in 0005, a future schema regen would think the indexes don't
-- exist and emit a DROP INDEX in some later migration.
--
-- IF NOT EXISTS so this is a no-op on environments where 0004 already
-- created the indexes (production, the local dev DB). Fresh DBs that
-- start at 0005 (none exist today, but the principle holds) would
-- create them now.
CREATE INDEX IF NOT EXISTS "sessions_billing_coach_start_idx" ON "sessions_billing" USING btree ("coach_id","start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_billing_resource_start_idx" ON "sessions_billing" USING btree ("resource_id","start_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_billing_start_idx" ON "sessions_billing" USING btree ("start_at");
