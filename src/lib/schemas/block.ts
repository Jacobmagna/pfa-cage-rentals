// Zod schemas for blocked-time mutations. Same shape-validation
// philosophy as session.ts: cross-cutting business rules (cross-
// table overlap with sessions) live in the server action.
//
// `reason` is required free text — surfaces in the schedule grid
// tooltip and in session-conflict error messages ("Cage 1 is
// blocked at this time for: Summer Camp 2026").

import { z } from "zod";

export const createBlockSchema = z.object({
  resourceId: z.string().min(1, "resourceId is required"),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  reason: z
    .string()
    .min(1, "Reason is required")
    .max(120, "Reason is at most 120 characters"),
});

// Same partial pattern as updateSessionSchema — every field optional,
// the update action treats `undefined` as "don't touch this column"
// and writes whatever's present in the parsed payload.
export const updateBlockSchema = createBlockSchema.partial();

export type CreateBlockInput = z.infer<typeof createBlockSchema>;
export type UpdateBlockInput = z.infer<typeof updateBlockSchema>;
