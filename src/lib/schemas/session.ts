// Zod schemas for billing-session mutations. Shape validation only —
// the cross-cutting business rule (block-vs-session overlap) lives in
// the server action because it requires a DB lookup before validating.
//
// `z.coerce.date()` accepts ISO strings from form submissions and
// JSON-style API calls alike, then hands the action a real Date.
// startAt < endAt is enforced both at the DB layer (CHECK constraint
// from C3) and by the action's downstream error translation; we
// deliberately don't re-add it as a Zod refine because the DB
// constraint is the canonical truth.

import { z } from "zod";

const sessionShape = {
  coachId: z.string().min(1, "coachId is required"),
  resourceId: z.string().min(1, "resourceId is required"),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  // nullish so the UPDATE form can send null to actually clear the
  // note — `optional()` alone would reject null at Zod parse, and a
  // missing-vs-undefined-vs-null distinction matters: updateSessionInternal
  // skips the column when the parsed value is `undefined` and writes
  // when it's `null`. See form-actions.ts buildSessionInput.
  note: z.string().max(500).nullish(),
};

const sessionBase = z.object(sessionShape);

// Upper bound on a single session's span. start < end is intentionally
// NOT refined here (the DB CHECK is canonical), but a date typo can
// still produce a huge span; 16h is generous vs the facility window.
// Zod-only — no DB constraint backs this max.
const MAX_DURATION_MS = 16 * 60 * 60 * 1000;
const maxDur = (v: { startAt: Date; endAt: Date }) =>
  v.endAt.getTime() - v.startAt.getTime() <= MAX_DURATION_MS;
// Update/partial case: no-op unless BOTH bounds are present.
const maxDurPartial = (v: { startAt?: Date; endAt?: Date }) =>
  !(v.startAt && v.endAt) ||
  v.endAt.getTime() - v.startAt.getTime() <= MAX_DURATION_MS;
const maxDurError = {
  message: "That span is over 16 hours — check the start/end (did the date slip?)",
  path: ["endAt"],
};

export const createSessionSchema = sessionBase.refine(maxDur, maxDurError);

export const updateSessionSchema = sessionBase
  .partial()
  .refine(maxDurPartial, maxDurError);

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;

// Batch-create: one coach + one resource, with N per-slot rows (each
// with its own start/end/note). Used by the multi-slot UI on
// /coach/sessions/new and the admin session dialogs. Hard cap at 50
// slots — a half-day of back-to-back 30-min lessons is ~20, so 50
// covers any reasonable case while preventing pathological inputs from
// blowing up the server.
export const createSessionBatchSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  resourceId: z.string().min(1, "resourceId is required"),
  slots: z
    .array(
      z
        .object({
          startAt: z.coerce.date(),
          endAt: z.coerce.date(),
          note: z.string().max(500).nullish(),
        })
        .refine(maxDur, maxDurError),
    )
    .min(1, "at least one slot is required")
    .max(50, "too many slots — max 50 per submission"),
});

export type CreateSessionBatchInput = z.infer<typeof createSessionBatchSchema>;

// 1b security: a coach's request to remove a PAST cage rental (an
// admin approves/denies it). `reason` is the coach's optional "why
// didn't it happen". nullish so a missing reason and an explicit-null
// reason both parse.
export const requestRemovalSchema = z.object({
  sessionId: z.string().min(1, "sessionId is required"),
  reason: z.string().max(500).nullish(),
});

// 1b security: an admin resolving (approving/denying) a removal request.
// `adminNote` is the optional deny reason.
export const resolveRemovalSchema = z.object({
  requestId: z.string().min(1, "requestId is required"),
  adminNote: z.string().max(500).nullish(),
});

export type RequestRemovalInput = z.infer<typeof requestRemovalSchema>;
export type ResolveRemovalInput = z.infer<typeof resolveRemovalSchema>;
