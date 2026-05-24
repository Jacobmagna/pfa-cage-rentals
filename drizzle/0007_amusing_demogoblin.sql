CREATE TABLE "blocked_times" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocked_times" ADD CONSTRAINT "blocked_times_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_times" ADD CONSTRAINT "blocked_times_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_times_resource_start_idx" ON "blocked_times" USING btree ("resource_id","start_at");--> statement-breakpoint

-- Raw-SQL constraints (Drizzle Kit can't emit CHECK or EXCLUDE).
-- btree_gist was already enabled by 0004, but the IF NOT EXISTS
-- here keeps this migration self-contained for fresh DBs that
-- might one day start at 0007 (none today, but defensive).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- Reject backwards or zero-duration block ranges. Mirrors sessions_billing.
ALTER TABLE "blocked_times" ADD CONSTRAINT "blocked_times_time_range_check" CHECK ("start_at" < "end_at");--> statement-breakpoint

-- Block-vs-block overlap rejected at the DB layer. Block-vs-session
-- enforcement is in C6 server actions (app-layer cross-table check —
-- Postgres EXCLUDE can't span tables).
ALTER TABLE "blocked_times" ADD CONSTRAINT "blocked_times_no_overlap" EXCLUDE USING gist ("resource_id" WITH =, tsrange("start_at", "end_at") WITH &&);
