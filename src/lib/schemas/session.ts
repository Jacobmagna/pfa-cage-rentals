// Zod schemas for billing-session mutations. Shape validation only —
// the cross-cutting business rules (useType-required-for-cage,
// block-vs-session overlap) live in the server action because they
// require a DB lookup before validating.
//
// `z.coerce.date()` accepts ISO strings from form submissions and
// JSON-style API calls alike, then hands the action a real Date.
// startAt < endAt is enforced both at the DB layer (CHECK constraint
// from C3) and by the action's downstream error translation; we
// deliberately don't re-add it as a Zod refine because the DB
// constraint is the canonical truth.

import { z } from "zod";

export const createSessionSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  resourceId: z.string().min(1, "resourceId is required"),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  useType: z.enum(["hitting", "pitching"]).nullish(),
  // nullish so the UPDATE form can send null to actually clear the
  // note — `optional()` alone would reject null at Zod parse, and a
  // missing-vs-undefined-vs-null distinction matters: updateSessionInternal
  // skips the column when the parsed value is `undefined` and writes
  // when it's `null`. See form-actions.ts buildSessionInput.
  note: z.string().max(500).nullish(),
});

export const updateSessionSchema = createSessionSchema.partial();

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
