CREATE TYPE "public"."cap_period" AS ENUM('week', 'month');--> statement-breakpoint
CREATE TABLE "athlete_programs" (
	"athlete_id" text NOT NULL,
	"program_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "athlete_programs_athlete_id_program_id_pk" PRIMARY KEY("athlete_id","program_id")
);
--> statement-breakpoint
CREATE TABLE "athletes" (
	"id" text PRIMARY KEY NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"birthday" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance_records" (
	"session_id" text NOT NULL,
	"athlete_id" text NOT NULL,
	"present" boolean NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_records_session_id_athlete_id_pk" PRIMARY KEY("session_id","athlete_id")
);
--> statement-breakpoint
CREATE TABLE "attendance_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"program_id" text NOT NULL,
	"session_date" date NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_programs" (
	"coach_id" text NOT NULL,
	"program_id" text NOT NULL,
	"assigned_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "coach_programs_coach_id_program_id_pk" PRIMARY KEY("coach_id","program_id")
);
--> statement-breakpoint
CREATE TABLE "hour_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"coach_id" text NOT NULL,
	"program_id" text NOT NULL,
	"start_at" timestamp NOT NULL,
	"end_at" timestamp NOT NULL,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"cap" integer,
	"cap_period" "cap_period",
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "programs_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "athlete_programs" ADD CONSTRAINT "athlete_programs_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athlete_programs" ADD CONSTRAINT "athlete_programs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_session_id_attendance_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."attendance_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_athlete_id_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_records" ADD CONSTRAINT "attendance_records_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_sessions" ADD CONSTRAINT "attendance_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_programs" ADD CONSTRAINT "coach_programs_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_programs" ADD CONSTRAINT "coach_programs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_logs" ADD CONSTRAINT "hour_logs_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_logs" ADD CONSTRAINT "hour_logs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hour_logs" ADD CONSTRAINT "hour_logs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "athlete_programs_program_idx" ON "athlete_programs" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "attendance_records_athlete_idx" ON "attendance_records" USING btree ("athlete_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_sessions_program_date_unique" ON "attendance_sessions" USING btree ("program_id","session_date");--> statement-breakpoint
CREATE INDEX "coach_programs_program_idx" ON "coach_programs" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "hour_logs_coach_start_idx" ON "hour_logs" USING btree ("coach_id","start_at");--> statement-breakpoint
CREATE INDEX "hour_logs_program_start_idx" ON "hour_logs" USING btree ("program_id","start_at");--> statement-breakpoint

-- Raw-SQL CHECK constraints (Drizzle Kit can't generate CHECK). Same
-- approach as sessions_billing's start<end CHECK in migration 0004.
-- See src/db/schema.ts programs + hour_logs comments for rationale.

-- programs.cap and programs.cap_period are co-required: both NULL (no
-- cap) or both NOT NULL. ((a IS NULL) = (b IS NULL)) is TRUE in both the
-- co-present and co-absent cases, FALSE when exactly one side is set.
ALTER TABLE "programs" ADD CONSTRAINT "programs_cap_period_co_required" CHECK (("programs"."cap" IS NULL) = ("programs"."cap_period" IS NULL));--> statement-breakpoint

-- Reject backwards or zero-duration hour logs. Mirrors sessions_billing.
ALTER TABLE "hour_logs" ADD CONSTRAINT "hour_logs_start_before_end" CHECK ("hour_logs"."start_at" < "hour_logs"."end_at");