// Zod schemas for per-coach rate override mutations.
//
// API surface is upsert + delete (no separate create/update): the
// table's composite PK on (coachId, resourceType) means a row either
// exists for that pair or it doesn't — upsert is the natural shape
// and matches how the H3 UI works (one input per resource type).

import { z } from "zod";

const RESOURCE_TYPES = ["cage", "bullpen", "weight_room"] as const;

export const upsertRateOverrideSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  resourceType: z.enum(RESOURCE_TYPES),
  // Stored in cents. Caller is responsible for the dollars → cents
  // conversion at the form-action layer (one source of truth for
  // currency formatting / rounding semantics — see form-actions.ts).
  ratePer30MinCents: z
    .number()
    .int("Rate must be a whole number of cents")
    .min(1, "Rate must be greater than $0")
    .max(1_000_00, "Rate cannot exceed $1,000 per 30 minutes"),
});

export const deleteRateOverrideSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  resourceType: z.enum(RESOURCE_TYPES),
});

export type UpsertRateOverrideInput = z.infer<typeof upsertRateOverrideSchema>;
export type DeleteRateOverrideInput = z.infer<typeof deleteRateOverrideSchema>;

// Per-coach PROGRAM rate overrides. Same upsert + delete shape as the
// resource-type overrides above, but keyed on (coachId, programId).
// When present, this wins over the program's defaultRatePer30MinCents.
export const upsertProgramRateOverrideSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  programId: z.string().min(1, "programId is required"),
  // Stored in cents. Dollars → cents conversion happens at the
  // form-action layer (same source of truth as the resource-type card).
  ratePer30MinCents: z
    .number()
    .int("Rate must be a whole number of cents")
    .min(1, "Rate must be greater than $0")
    .max(1_000_00, "Rate cannot exceed $1,000 per 30 minutes"),
});

export const deleteProgramRateOverrideSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  programId: z.string().min(1, "programId is required"),
});

export type UpsertProgramRateOverrideInput = z.infer<
  typeof upsertProgramRateOverrideSchema
>;
export type DeleteProgramRateOverrideInput = z.infer<
  typeof deleteProgramRateOverrideSchema
>;
