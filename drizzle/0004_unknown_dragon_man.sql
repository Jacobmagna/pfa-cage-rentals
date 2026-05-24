CREATE TYPE "public"."use_type" AS ENUM('hitting', 'pitching');--> statement-breakpoint
CREATE TABLE "sessions_billing" (
	"id" text PRIMARY KEY NOT NULL,
	"coach_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"use_type" "use_type",
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions_billing" ADD CONSTRAINT "sessions_billing_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions_billing" ADD CONSTRAINT "sessions_billing_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions_billing" ADD CONSTRAINT "sessions_billing_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Raw-SQL constraints (Drizzle Kit can't generate CHECK or EXCLUDE).
-- btree_gist is needed for the EXCLUDE constraint to combine
-- equality (resource_id) with range overlap (tsrange).
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- Reject backwards or zero-duration ranges. Mirrors the app-layer
-- check in src/lib/billing.ts:slotsBetween but the DB is the final
-- word for any direct-SQL writes.
ALTER TABLE "sessions_billing" ADD CONSTRAINT "sessions_billing_time_range_check" CHECK ("start_at" < "end_at");--> statement-breakpoint

-- The real teeth: two sessions on the same resource cannot overlap.
-- Race-safe at the DB level — two simultaneous inserts both pass
-- the app-layer check, but only one survives this constraint.
-- Block-vs-session overlap is enforced by C5 + the C6 server
-- action (cross-table check happens in app code).
ALTER TABLE "sessions_billing" ADD CONSTRAINT "sessions_billing_no_overlap" EXCLUDE USING gist ("resource_id" WITH =, tsrange("start_at", "end_at") WITH &&);--> statement-breakpoint

-- Indexes for the common read paths:
--   (coach_id, start_at) — D2 "my sessions in May" coach history
--   (resource_id, start_at) — F1 schedule grid by-day lookups
--   (start_at) — E1 admin date-range reports
CREATE INDEX "sessions_billing_coach_start_idx" ON "sessions_billing" ("coach_id", "start_at");--> statement-breakpoint
CREATE INDEX "sessions_billing_resource_start_idx" ON "sessions_billing" ("resource_id", "start_at");--> statement-breakpoint
CREATE INDEX "sessions_billing_start_idx" ON "sessions_billing" ("start_at");
