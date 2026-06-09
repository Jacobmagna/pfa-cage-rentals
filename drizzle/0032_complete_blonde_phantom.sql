CREATE TYPE "public"."removal_request_status" AS ENUM('pending', 'approved', 'denied');--> statement-breakpoint
CREATE TABLE "session_removal_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"coach_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"rate_per_30_min_cents" integer,
	"reason" text,
	"status" "removal_request_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp DEFAULT now() NOT NULL,
	"requested_by" text NOT NULL,
	"resolved_at" timestamp,
	"resolved_by" text,
	"admin_note" text
);
--> statement-breakpoint
ALTER TABLE "session_removal_requests" ADD CONSTRAINT "session_removal_requests_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_removal_requests" ADD CONSTRAINT "session_removal_requests_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_removal_requests" ADD CONSTRAINT "session_removal_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_removal_requests" ADD CONSTRAINT "session_removal_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_removal_requests_status_idx" ON "session_removal_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "session_removal_requests_coach_idx" ON "session_removal_requests" USING btree ("coach_id");--> statement-breakpoint
CREATE INDEX "session_removal_requests_session_idx" ON "session_removal_requests" USING btree ("session_id");