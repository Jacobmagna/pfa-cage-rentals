// Zod schemas for coach hour-log mutations. startAt/endAt use
// z.coerce.date() (matching session.ts) so ISO strings from forms /
// JSON become real Dates. endAt > startAt is enforced here AND by the DB
// CHECK constraint; the DB is canonical, this gives a friendly error.

import { z } from "zod";

const hourLogShape = {
  programId: z.string().min(1, "programId is required"),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  note: z.string().max(2000).nullish(),
};

// 1b security B: create-only fields that drive the held-then-approve gate.
// Both OPTIONAL so existing callers are unaffected. `source` discriminates
// the trusted auto-confirm path ("schedule-confirm", never anomaly-checked)
// from manual entry (default, anomaly-checked); `acknowledgeHold` is the
// coach's "yes, send this anomalous log to an admin for approval" consent.
const createOnlyShape = {
  source: z.enum(["manual", "schedule-confirm"]).optional(),
  acknowledgeHold: z.boolean().optional(),
};

const endAfterStart = (v: { startAt: Date; endAt: Date }) =>
  v.startAt < v.endAt;
const endAfterStartError = {
  message: "endAt must be after startAt",
  path: ["endAt"],
};

// Upper bound on a single log's span. 16h is generous vs the 8 AM–10 PM
// facility window but catches a date typo that produces a 24h+ span.
// Zod-only — no DB constraint backs this (unlike endAt > startAt).
const MAX_DURATION_MS = 16 * 60 * 60 * 1000;
const underMaxDuration = (v: { startAt: Date; endAt: Date }) =>
  v.endAt.getTime() - v.startAt.getTime() <= MAX_DURATION_MS;
const underMaxDurationError = {
  message: "That span is over 16 hours — check the start/end (did the date slip?)",
  path: ["endAt"],
};

export const createHourLogSchema = z
  .object({ ...hourLogShape, ...createOnlyShape })
  .refine(endAfterStart, endAfterStartError)
  .refine(underMaxDuration, underMaxDurationError);

export const editHourLogSchema = z
  .object(hourLogShape)
  .refine(endAfterStart, endAfterStartError)
  .refine(underMaxDuration, underMaxDurationError);

export type CreateHourLogInput = z.infer<typeof createHourLogSchema>;
export type EditHourLogInput = z.infer<typeof editHourLogSchema>;
