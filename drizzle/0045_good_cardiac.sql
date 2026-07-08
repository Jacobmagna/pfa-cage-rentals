CREATE TABLE "travel_athletes" (
	"id" text PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"grad_year" integer,
	"current_school" text,
	"age_group" text,
	"bats" text,
	"throws" text,
	"jersey_no" text,
	"positions" text,
	"uniform_size" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_divisions" (
	"id" text PRIMARY KEY NOT NULL,
	"season_id" text NOT NULL,
	"location_id" text,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_locations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"is_hq" boolean DEFAULT false NOT NULL,
	"brand" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_seasons" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"timezone" text DEFAULT 'America/Los_Angeles' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_team_athletes" (
	"team_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"status" text,
	CONSTRAINT "travel_team_athletes_team_id_athlete_id_pk" PRIMARY KEY("team_id","athlete_id")
);
--> statement-breakpoint
CREATE TABLE "travel_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"division_id" text,
	"location_id" text,
	"cohort" text,
	"is_private" boolean DEFAULT true NOT NULL,
	"head_manager_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "travel_divisions" ADD CONSTRAINT "travel_divisions_season_id_travel_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."travel_seasons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_divisions" ADD CONSTRAINT "travel_divisions_location_id_travel_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."travel_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_team_athletes" ADD CONSTRAINT "travel_team_athletes_team_id_travel_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."travel_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_team_athletes" ADD CONSTRAINT "travel_team_athletes_athlete_id_travel_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."travel_athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_teams" ADD CONSTRAINT "travel_teams_division_id_travel_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."travel_divisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_teams" ADD CONSTRAINT "travel_teams_location_id_travel_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."travel_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_teams" ADD CONSTRAINT "travel_teams_head_manager_user_id_users_id_fk" FOREIGN KEY ("head_manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travel_divisions_season_idx" ON "travel_divisions" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "travel_divisions_location_idx" ON "travel_divisions" USING btree ("location_id");--> statement-breakpoint
CREATE INDEX "travel_team_athletes_athlete_idx" ON "travel_team_athletes" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "travel_teams_division_idx" ON "travel_teams" USING btree ("division_id");--> statement-breakpoint
CREATE INDEX "travel_teams_location_idx" ON "travel_teams" USING btree ("location_id");