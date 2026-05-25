CREATE TYPE "public"."payment_method" AS ENUM('venmo', 'zelle', 'check', 'cash', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'confirmed');--> statement-breakpoint
CREATE TABLE "coach_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"coach_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"paid_at" timestamp NOT NULL,
	"reference" text,
	"note" text,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"recorded_by" text NOT NULL,
	"confirmed_by" text,
	"confirmed_at" timestamp,
	"recorded_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "coach_payments" ADD CONSTRAINT "coach_payments_coach_id_users_id_fk" FOREIGN KEY ("coach_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_payments" ADD CONSTRAINT "coach_payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_payments" ADD CONSTRAINT "coach_payments_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_payments_coach_paid_idx" ON "coach_payments" USING btree ("coach_id","paid_at");--> statement-breakpoint
CREATE INDEX "coach_payments_status_paid_idx" ON "coach_payments" USING btree ("status","paid_at");