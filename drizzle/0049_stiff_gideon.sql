CREATE TABLE "travel_discounts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"method" text NOT NULL,
	"amount_cents" integer,
	"percent" integer,
	"applies_to_product_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"athlete_id" text NOT NULL,
	"product_id" text NOT NULL,
	"registration_id" text,
	"status" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_invoice_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"description" text,
	"amount_cents" integer NOT NULL,
	"product_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"guardian_id" text,
	"athlete_id" text,
	"product_id" text,
	"total_cents" integer NOT NULL,
	"balance_cents" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"purchase_source" text DEFAULT 'consumer' NOT NULL,
	"due_date" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_products" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"location_id" text,
	"season_id" text,
	"team_id" text,
	"base_price_cents" integer,
	"price_tiers" jsonb,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"product_id" text NOT NULL,
	"athlete_id" text,
	"guardian_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text DEFAULT 'consumer' NOT NULL,
	"form_data" jsonb,
	"submitted_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "travel_discounts" ADD CONSTRAINT "travel_discounts_applies_to_product_id_travel_products_id_fk" FOREIGN KEY ("applies_to_product_id") REFERENCES "public"."travel_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_enrollments" ADD CONSTRAINT "travel_enrollments_athlete_id_travel_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."travel_athletes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_enrollments" ADD CONSTRAINT "travel_enrollments_product_id_travel_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."travel_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_enrollments" ADD CONSTRAINT "travel_enrollments_registration_id_travel_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."travel_registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_invoice_lines" ADD CONSTRAINT "travel_invoice_lines_invoice_id_travel_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."travel_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_invoice_lines" ADD CONSTRAINT "travel_invoice_lines_product_id_travel_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."travel_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_invoices" ADD CONSTRAINT "travel_invoices_guardian_id_travel_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."travel_guardians"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_invoices" ADD CONSTRAINT "travel_invoices_athlete_id_travel_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."travel_athletes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_invoices" ADD CONSTRAINT "travel_invoices_product_id_travel_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."travel_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_products" ADD CONSTRAINT "travel_products_location_id_travel_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."travel_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_products" ADD CONSTRAINT "travel_products_season_id_travel_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."travel_seasons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_products" ADD CONSTRAINT "travel_products_team_id_travel_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."travel_teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_registrations" ADD CONSTRAINT "travel_registrations_product_id_travel_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."travel_products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_registrations" ADD CONSTRAINT "travel_registrations_athlete_id_travel_athletes_id_fk" FOREIGN KEY ("athlete_id") REFERENCES "public"."travel_athletes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_registrations" ADD CONSTRAINT "travel_registrations_guardian_id_travel_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."travel_guardians"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "travel_enrollments_athlete_product_unique" ON "travel_enrollments" USING btree ("athlete_id","product_id");--> statement-breakpoint
CREATE INDEX "travel_enrollments_product_idx" ON "travel_enrollments" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "travel_invoice_lines_invoice_idx" ON "travel_invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "travel_invoices_guardian_idx" ON "travel_invoices" USING btree ("guardian_id");--> statement-breakpoint
CREATE INDEX "travel_invoices_athlete_idx" ON "travel_invoices" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "travel_products_season_idx" ON "travel_products" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "travel_products_team_idx" ON "travel_products" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "travel_registrations_product_idx" ON "travel_registrations" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "travel_registrations_athlete_idx" ON "travel_registrations" USING btree ("athlete_id");--> statement-breakpoint
CREATE INDEX "travel_registrations_guardian_idx" ON "travel_registrations" USING btree ("guardian_id");