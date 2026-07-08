CREATE TABLE "travel_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text,
	"athlete_first_name" text NOT NULL,
	"athlete_last_name" text NOT NULL,
	"athlete_grad_year" integer,
	"athlete_positions" text,
	"parent_first_name" text NOT NULL,
	"parent_last_name" text NOT NULL,
	"parent_email" text NOT NULL,
	"parent_phone" text,
	"message" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"review_note" text,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "travel_applications" ADD CONSTRAINT "travel_applications_team_id_travel_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."travel_teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travel_applications_status_idx" ON "travel_applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "travel_applications_team_idx" ON "travel_applications" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "travel_applications_parent_email_idx" ON "travel_applications" USING btree ("parent_email");