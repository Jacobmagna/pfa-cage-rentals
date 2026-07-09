CREATE TABLE "travel_installments" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"seq" integer NOT NULL,
	"due_date" timestamp,
	"amount_cents" integer NOT NULL,
	"paid_amount_cents" integer DEFAULT 0 NOT NULL,
	"paid_date" timestamp,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_payment_methods" (
	"id" text PRIMARY KEY NOT NULL,
	"guardian_id" text NOT NULL,
	"stripe_payment_method_id" text,
	"kind" text NOT NULL,
	"brand" text,
	"last4" text,
	"exp_month" integer,
	"exp_year" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_payment_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"kind" text NOT NULL,
	"n_installments" integer,
	"schedule_type" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_payments" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text,
	"guardian_id" text,
	"payment_method_id" text,
	"amount_cents" integer NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"stripe_charge_id" text,
	"stripe_payment_intent_id" text,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"stripe_refund_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_scheduled_charges" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"payment_method_id" text,
	"run_on" timestamp NOT NULL,
	"amount_cents" integer NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"stripe_ref" text,
	"claimed_at" timestamp,
	"installment_id" text,
	"failure_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "travel_guardians" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "travel_products" ADD COLUMN "deposit_cents" integer;--> statement-breakpoint
ALTER TABLE "travel_installments" ADD CONSTRAINT "travel_installments_plan_id_travel_payment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."travel_payment_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_payment_methods" ADD CONSTRAINT "travel_payment_methods_guardian_id_travel_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."travel_guardians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_payment_plans" ADD CONSTRAINT "travel_payment_plans_invoice_id_travel_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."travel_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_payments" ADD CONSTRAINT "travel_payments_invoice_id_travel_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."travel_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_payments" ADD CONSTRAINT "travel_payments_guardian_id_travel_guardians_id_fk" FOREIGN KEY ("guardian_id") REFERENCES "public"."travel_guardians"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_payments" ADD CONSTRAINT "travel_payments_payment_method_id_travel_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."travel_payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_refunds" ADD CONSTRAINT "travel_refunds_payment_id_travel_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."travel_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_scheduled_charges" ADD CONSTRAINT "travel_scheduled_charges_invoice_id_travel_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."travel_invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_scheduled_charges" ADD CONSTRAINT "travel_scheduled_charges_payment_method_id_travel_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."travel_payment_methods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_scheduled_charges" ADD CONSTRAINT "travel_scheduled_charges_installment_id_travel_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."travel_installments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "travel_installments_plan_idx" ON "travel_installments" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "travel_installments_plan_seq_unique" ON "travel_installments" USING btree ("plan_id","seq");--> statement-breakpoint
CREATE INDEX "travel_payment_methods_guardian_idx" ON "travel_payment_methods" USING btree ("guardian_id");--> statement-breakpoint
CREATE UNIQUE INDEX "travel_payment_methods_stripe_pm_unique" ON "travel_payment_methods" USING btree ("stripe_payment_method_id");--> statement-breakpoint
CREATE INDEX "travel_payment_plans_invoice_idx" ON "travel_payment_plans" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "travel_payments_invoice_idx" ON "travel_payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "travel_payments_guardian_idx" ON "travel_payments" USING btree ("guardian_id");--> statement-breakpoint
CREATE UNIQUE INDEX "travel_payments_stripe_pi_unique" ON "travel_payments" USING btree ("stripe_payment_intent_id");--> statement-breakpoint
CREATE INDEX "travel_refunds_payment_idx" ON "travel_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "travel_scheduled_charges_invoice_idx" ON "travel_scheduled_charges" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "travel_scheduled_charges_run_on_idx" ON "travel_scheduled_charges" USING btree ("run_on");--> statement-breakpoint
CREATE UNIQUE INDEX "travel_scheduled_charges_installment_unique" ON "travel_scheduled_charges" USING btree ("installment_id");