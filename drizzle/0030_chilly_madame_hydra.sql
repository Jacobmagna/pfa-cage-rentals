CREATE TABLE "athlete_merge_dismissals" (
	"id" text PRIMARY KEY NOT NULL,
	"athlete_a_id" text NOT NULL,
	"athlete_b_id" text NOT NULL,
	"dismissed_by" text,
	"dismissed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "athlete_merge_dismissals" ADD CONSTRAINT "athlete_merge_dismissals_athlete_a_id_athletes_id_fk" FOREIGN KEY ("athlete_a_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_merge_dismissals" ADD CONSTRAINT "athlete_merge_dismissals_athlete_b_id_athletes_id_fk" FOREIGN KEY ("athlete_b_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_merge_dismissals" ADD CONSTRAINT "athlete_merge_dismissals_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "athlete_merge_dismissals_pair_unique" ON "athlete_merge_dismissals" USING btree ("athlete_a_id","athlete_b_id");