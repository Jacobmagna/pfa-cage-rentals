CREATE TABLE "travel_guardian_athletes" (
	"guardian_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"relationship" text,
	"is_primary" boolean DEFAULT true NOT NULL,
	CONSTRAINT "travel_guardian_athletes_guardian_id_athlete_id_pk" PRIMARY KEY("guardian_id","athlete_id")
);
--> statement-breakpoint
CREATE TABLE "travel_guardians" (
	"id" text PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"password_hash" text,
	"email_verified" timestamp,
	"is_account_owner" boolean DEFAULT true NOT NULL,
	"email_opt_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "travel_guardians_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "travel_guardian_athletes" ADD CONSTRAINT "travel_guardian_athletes_guardian_id_travel_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."travel_guardians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_guardian_athletes" ADD CONSTRAINT "travel_guardian_athletes_athlete_id_travel_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."travel_athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travel_guardian_athletes_athlete_idx" ON "travel_guardian_athletes" USING btree ("athlete_id");