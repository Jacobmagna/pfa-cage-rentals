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

const endAfterStart = (v: { startAt: Date; endAt: Date }) =>
  v.startAt < v.endAt;
const endAfterStartError = {
  message: "endAt must be after startAt",
  path: ["endAt"],
};

export const createHourLogSchema = z
  .object(hourLogShape)
  .refine(endAfterStart, endAfterStartError);

export const editHourLogSchema = z
  .object(hourLogShape)
  .refine(endAfterStart, endAfterStartError);

// QA10 W3-polish15: a coach cancelling their assignment to a scheduled
// program block. reason is optional free text (trimmed, capped) explaining
// why the block won't happen for them.
export const cancelBlockSchema = z.object({
  blockId: z.string().min(1, "blockId is required"),
  reason: z.string().trim().max(500).optional(),
});

export type CreateHourLogInput = z.infer<typeof createHourLogSchema>;
export type EditHourLogInput = z.infer<typeof editHourLogSchema>;
export type CancelBlockInput = z.infer<typeof cancelBlockSchema>;
