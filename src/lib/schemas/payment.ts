// Zod schemas for coachPayments mutations. Shape validation only —
// authz (admin role) lives in the public action wrappers and any
// cross-row checks (coach exists + not deleted) live in the internal
// action because they need a DB lookup.
//
// Amount discipline: integer cents, must be > 0. Dollar inputs from
// the form get converted at the form-action boundary (dollarsToCents
// in form-actions.ts).

import { z } from "zod";

const METHODS = ["venmo", "zelle", "check", "cash", "other"] as const;

// QA2 #9 — payment direction. "coach_to_pfa" = a coach paying down what they
// owe PFA (cage rentals); "pfa_to_coach" = PFA paying a coach out for work
// hours. Defaults to "coach_to_pfa" so legacy form submits stay correct.
const DIRECTIONS = ["coach_to_pfa", "pfa_to_coach"] as const;

export const createPaymentSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  amountCents: z
    .number()
    .int("amount must be whole cents")
    .positive("amount must be greater than zero")
    .max(100_000_00, "amount can't exceed $100,000"),
  method: z.enum(METHODS),
  direction: z.enum(DIRECTIONS).default("coach_to_pfa"),
  paidAt: z.coerce.date(),
  reference: z.string().max(200).nullish(),
  note: z.string().max(500).nullish(),
});

// Same null/undefined semantics as the session schemas: explicit
// `null` clears the column, omitted = leave unchanged.
//
// `direction` gets the explicit-optional treatment (no `.default()`) on
// update: `.partial()` alone does NOT strip a field's `.default()`, so an
// edit that didn't resend `direction` would silently coerce it back to
// "coach_to_pfa" and flip a pfa_to_coach payment. Overriding the field to a
// plain `.optional()` enum preserves "omitted = unchanged".
export const updatePaymentSchema = createPaymentSchema.partial().extend({
  direction: z.enum(DIRECTIONS).optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export type PaymentMethod = (typeof METHODS)[number];
export const PAYMENT_METHODS = METHODS;

export type PaymentDirection = (typeof DIRECTIONS)[number];
export const PAYMENT_DIRECTIONS = DIRECTIONS;
