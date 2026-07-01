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

// ---------------------------------------------------------------------------
// BLOCK-RECUR: recurring blocked-time SERIES schemas. Mirrors the program
// series schema (src/lib/schemas/program-schedule.ts) but scoped to a SINGLE
// resource + a free-text reason (no coaches / no separate occupancy table).
// Structural/format rules live here; the occurrence cap + resource-exists +
// per-occurrence conflict handling live in the generator + action.
//
//  - daysOfWeek: 0=Sunday .. 6=Saturday (getUTCDay convention), non-empty.
//  - startTime/endTime: zero-padded 24h "HH:MM"; start<end enforced here.
//  - startsOn/endsOn: "YYYY-MM-DD" PFA calendar dates (endsOn inclusive).
//  - frequency/interval default to weekly/1 (weekly-every-week).

const BLOCK_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const BLOCK_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const blockSeriesShape = {
  resourceId: z.string().min(1, "resourceId is required"),
  reason: z
    .string()
    .min(1, "Reason is required")
    .max(120, "Reason is at most 120 characters"),
  daysOfWeek: z
    .array(z.number().int().min(0).max(6))
    .min(1, "Pick at least one weekday"),
  startTime: z.string().regex(BLOCK_TIME_RE, "startTime must be HH:MM (24h)"),
  endTime: z.string().regex(BLOCK_TIME_RE, "endTime must be HH:MM (24h)"),
  startsOn: z.string().regex(BLOCK_DATE_RE, "startsOn must be YYYY-MM-DD"),
  endsOn: z.string().regex(BLOCK_DATE_RE, "endsOn must be YYYY-MM-DD"),
  frequency: z.enum(["weekly", "monthly"]).default("weekly"),
  interval: z.coerce
    .number()
    .int("interval must be a whole number")
    .min(1, "interval must be at least 1")
    .default(1),
};

const blockSeriesBase = z.object(blockSeriesShape);

const blockSeriesTimeError = {
  message: "startTime must be before endTime",
  path: ["endTime"],
};
const blockSeriesDateError = {
  message: "startsOn must be on or before endsOn",
  path: ["endsOn"],
};

export const createBlockSeriesSchema = blockSeriesBase
  .refine((v) => v.startTime < v.endTime, blockSeriesTimeError)
  .refine((v) => v.startsOn <= v.endsOn, blockSeriesDateError);

// Edit sends the full series definition on save (the regenerate step reads
// every field), so the shape is identical to create.
export const editBlockSeriesSchema = blockSeriesBase
  .refine((v) => v.startTime < v.endTime, blockSeriesTimeError)
  .refine((v) => v.startsOn <= v.endsOn, blockSeriesDateError);

export type CreateBlockSeriesInput = z.infer<typeof createBlockSeriesSchema>;
export type EditBlockSeriesInput = z.infer<typeof editBlockSeriesSchema>;
