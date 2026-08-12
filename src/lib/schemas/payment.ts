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

// payment-statement SPEC §4 — typo guards for `coversThrough`, and ONLY typo
// guards. Both are expressed as bounds on the instant so they read identically
// on create and update.
//
// Lower bound: PFA went live 2026-06-19; there are no charges to settle before
// the system existed, so an earlier coverage date is a mis-key rather than a
// real period. Compared as a UTC midnight so a legitimate go-live-day value
// (stored at PFA midnight = 07:00Z) sits comfortably inside the bound.
const COVERS_THROUGH_MIN = new Date("2026-06-19T00:00:00.000Z");
const COVERS_THROUGH_MIN_MESSAGE =
  "Coverage date can't be before PFA went live (June 19, 2026)";
const COVERS_THROUGH_MAX_MESSAGE =
  "Coverage date can't be more than a year from now";

// Upper bound is a year out, evaluated at parse time — it exists to catch a
// typo'd year like 2206, nothing else.
//
// ⚠️ Future dates are DELIBERATELY ALLOWED here, which is the opposite call
// from `0054`'s future-dating ban on `effective_from`. The difference is what
// the date means: `effective_from` is a RE-PRICING INSTRUCTION that moves
// money, so a future one would silently mis-bill; `coversThrough` is a LABEL on
// money that ALREADY moved. A coach prepaying through the end of next month is
// a real thing Mark can receive, and a statement has to be able to say so.
function coversThroughMax(): number {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.getTime();
}

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
  // The PERIOD this money settles, as opposed to `paidAt` (when it arrived).
  // Nullish with NO `.default()`: `null` = "no period stated" and CLEARS the
  // column, omitted = leave unchanged. It gets the same explicit-optional
  // treatment `direction` needed below and for the same reason — `.partial()`
  // does NOT strip a `.default()`, so any default here would re-assert itself
  // on every edit that didn't resend the field.
  //
  // Both guards are attached to the FIELD (not to the object) so `.partial()`
  // carries them onto the update schema unchanged; the integration suite
  // asserts that on both paths rather than trusting it.
  coversThrough: z.coerce
    .date()
    .refine(
      (d) => d.getTime() >= COVERS_THROUGH_MIN.getTime(),
      COVERS_THROUGH_MIN_MESSAGE,
    )
    .refine((d) => d.getTime() <= coversThroughMax(), COVERS_THROUGH_MAX_MESSAGE)
    .nullish(),
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
