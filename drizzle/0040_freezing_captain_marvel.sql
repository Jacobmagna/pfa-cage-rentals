CREATE TABLE "blocked_times_series" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_id" text NOT NULL,
	"reason" text NOT NULL,
	"days_of_week" integer[] NOT NULL,
	"frequency" "recurrence_frequency" DEFAULT 'weekly' NOT NULL,
	"recurrence_interval" integer DEFAULT 1 NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"starts_on" text NOT NULL,
	"ends_on" text NOT NULL,
	"skip_dates" text[] DEFAULT '{}' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blocked_times" ADD COLUMN "blocked_time_series_id" text;--> statement-breakpoint
ALTER TABLE "blocked_times_series" ADD CONSTRAINT "blocked_times_series_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_times_series" ADD CONSTRAINT "blocked_times_series_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_times" ADD CONSTRAINT "blocked_times_blocked_time_series_id_blocked_times_series_id_fk" FOREIGN KEY ("blocked_time_series_id") REFERENCES "public"."blocked_times_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_times_series_idx" ON "blocked_times" USING btree ("blocked_time_series_id");