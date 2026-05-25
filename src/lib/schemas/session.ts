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
  // Team-rental flag. Optional on create (defaults to false); on
  // update, omitted = keep existing, explicit value = overwrite.
  isTeamRental: z.boolean().optional(),
});

export const updateSessionSchema = createSessionSchema.partial();

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

// Batch-create: one coach + one resource + one useType, with N
// per-slot rows (each with its own start/end/note/teamRental).
// Used by the multi-slot UI on /coach/sessions/new and the admin
// session dialogs. Hard cap at 50 slots — a half-day of back-to-
// back 30-min lessons is ~20, so 50 covers any reasonable case
// while preventing pathological inputs from blowing up the server.
export const createSessionBatchSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  resourceId: z.string().min(1, "resourceId is required"),
  useType: z.enum(["hitting", "pitching"]).nullish(),
  slots: z
    .array(
      z.object({
        startAt: z.coerce.date(),
        endAt: z.coerce.date(),
        note: z.string().max(500).nullish(),
        isTeamRental: z.boolean().optional(),
      }),
    )
    .min(1, "at least one slot is required")
    .max(50, "too many slots — max 50 per submission"),
});

export type CreateSessionBatchInput = z.infer<typeof createSessionBatchSchema>;
