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
  // GROUP-RATE (4th tier): BOOKING-LEVEL flag — only meaningful for a
  // weight-room slot. Default false so every existing create/edit path is
  // byte-identical (a slot bills at its regular rate unless the booker
  // explicitly flags a weight-room group session). createSessionInternal
  // gates it on the resource type; a group flag on a non-weight-room slot
  // is ignored.
  isGroupSession: z.boolean().optional().default(false),
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

// Batch-create: one coach + N per-slot rows (each with its own
// start/end/note, and OPTIONALLY its own resource). Used by the
// multi-slot UI on /coach/sessions/new and the admin session dialogs.
//
// Multi-resource support: a single atomic batch can span multiple cages
// (or a cage + a bullpen), each row billed at ITS resource type's rate.
// Each slot may carry its own `resourceId`; if it doesn't, the slot
// falls back to the top-level `resourceId`. Both `resourceId` fields are
// optional at the shape level, but the superRefine below guarantees
// every slot resolves to SOME resourceId. Back-compat: the old
// single-resource shape (top-level `resourceId` + slots with no
// per-slot resourceId) still parses and behaves exactly as before.
//
// Hard cap at 50 slots — a half-day of back-to-back 30-min lessons is
// ~20, so 50 covers any reasonable case while preventing pathological
// inputs from blowing up the server.
export const createSessionBatchSchema = z
  .object({
    coachId: z.string().min(1, "coachId is required"),
    // Optional top-level default resource — a slot without its own
    // resourceId inherits this. Still required in practice (the
    // superRefine rejects a slot that resolves to nothing), but no
    // longer mandatory at the shape level so per-slot resources can
    // fully supply it.
    resourceId: z.string().min(1).optional(),
    // GROUP-RATE (4th tier): BOOKING-LEVEL flag (one toggle for the whole
    // batch, NOT per-slot). Only meaningful for weight-room rows; in a mixed
    // batch, non-weight-room rows ignore it. Default false → byte-identical
    // to the pre-group batch behavior.
    isGroupSession: z.boolean().optional().default(false),
    slots: z
      .array(
        z
          .object({
            startAt: z.coerce.date(),
            endAt: z.coerce.date(),
            note: z.string().max(500).nullish(),
            // Optional per-slot resource. When present it WINS over the
            // top-level resourceId for that slot.
            resourceId: z.string().min(1).optional(),
          })
          .refine(maxDur, maxDurError),
      )
      .min(1, "at least one slot is required")
      .max(50, "too many slots — max 50 per submission"),
  })
  .superRefine((val, ctx) => {
    // Every slot must resolve to a resourceId via slot-or-top-level.
    val.slots.forEach((slot, i) => {
      if (!effectiveResourceId(slot, val.resourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "resourceId is required (slot or top-level)",
          path: ["slots", i, "resourceId"],
        });
      }
    });
  });

export type CreateSessionBatchInput = z.infer<typeof createSessionBatchSchema>;

// Single source of truth for slot→resource resolution: a slot's own
// resourceId wins; otherwise it inherits the batch's top-level
// resourceId. Shared by the schema's superRefine, the batch action, and
// the tests so the rule can never drift between them. Returns undefined
// only when NEITHER is set (the case the superRefine rejects).
export function effectiveResourceId(
  slot: { resourceId?: string },
  topResourceId?: string,
): string | undefined {
  return slot.resourceId ?? topResourceId;
}

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
