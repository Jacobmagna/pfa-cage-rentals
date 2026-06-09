CREATE TABLE "session_cancellations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"coach_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"rate_per_30_min_cents" integer,
	"note" text,
	"cancelled_at" timestamp DEFAULT now() NOT NULL,
	"cancelled_by" text NOT NULL,
	"lead_time_mins" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD CONSTRAINT "session_cancellations_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD CONSTRAINT "session_cancellations_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_cancellations" ADD CONSTRAINT "session_cancellations_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "session_cancellations_session_idx" ON "session_cancellations" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_cancellations_coach_idx" ON "session_cancellations" USING btree ("coach_id");--> statement-breakpoint
CREATE INDEX "session_cancellations_cancelled_at_idx" ON "session_cancellations" USING btree ("cancelled_at");