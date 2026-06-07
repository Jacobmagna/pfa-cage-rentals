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

export const createPaymentSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  amountCents: z
    .number()
    .int("amount must be whole cents")
    .positive("amount must be greater than zero")
    .max(100_000_00, "amount can't exceed $100,000"),
  method: z.enum(METHODS),
  paidAt: z.coerce.date(),
  reference: z.string().max(200).nullish(),
  note: z.string().max(500).nullish(),
});

// Same null/undefined semantics as the session schemas: explicit
// `null` clears the column, omitted = leave unchanged.
export const updatePaymentSchema = createPaymentSchema.partial();

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type UpdatePaymentInput = z.infer<typeof updatePaymentSchema>;

export type PaymentMethod = (typeof METHODS)[number];
export const PAYMENT_METHODS = METHODS;
