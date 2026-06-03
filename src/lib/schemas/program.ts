// Zod schemas for program mutations. Shape + the cap⇔capPeriod
// co-requirement (mirrors the DB CHECK constraint): a program either has
// both a cap and a period, or neither. The DB CHECK is the canonical
// truth; this refine gives a friendly error before the round-trip.

import { z } from "zod";

// Must match the cap_period pgEnum in src/db/schema.ts.
export const capPeriodSchema = z.enum(["week", "month"]);

// Both-or-neither: cap and capPeriod are co-required. `undefined` and
// `null` both count as "absent" so create (omit) and update (clear via
// null) share one rule.
function capCoRequired(v: {
  cap?: number | null;
  capPeriod?: "week" | "month" | null;
}): boolean {
  const hasCap = v.cap !== undefined && v.cap !== null;
  const hasPeriod = v.capPeriod !== undefined && v.capPeriod !== null;
  return hasCap === hasPeriod;
}

const capCoRequiredError = {
  message: "cap and capPeriod must be set together or both omitted",
  path: ["cap"],
};

export const createProgramSchema = z
  .object({
    name: z.string().min(1, "name is required").max(200),
    cap: z.number().int().positive().nullish(),
    capPeriod: capPeriodSchema.nullish(),
    active: z.boolean().optional(),
    // Per-program default pay rate, in integer cents per 30-min slot.
    // null/absent = no rate set ($0 pay until configured). Cap mirrors
    // the per-coach override cap ($1,000 / 30 min). Dollars→cents
    // conversion happens at the form-action layer.
    defaultRatePer30MinCents: z
      .number()
      .int()
      .min(0)
      .max(1_000_00)
      .nullish(),
  })
  .refine(capCoRequired, capCoRequiredError);

// All fields optional for partial updates; cap/capPeriod accept null to
// explicitly clear them (together). Co-requirement still enforced.
export const updateProgramSchema = z
  .object({
    name: z.string().min(1, "name is required").max(200).optional(),
    cap: z.number().int().positive().nullable().optional(),
    capPeriod: capPeriodSchema.nullable().optional(),
    active: z.boolean().optional(),
    // null clears the rate back to "no rate set".
    defaultRatePer30MinCents: z
      .number()
      .int()
      .min(0)
      .max(1_000_00)
      .nullish(),
  })
  .refine(capCoRequired, capCoRequiredError);

export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
