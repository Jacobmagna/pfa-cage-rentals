// Zod schemas for program mutations. The program-level session cap was
// removed — the cap is now a PER-ATHLETE enrollment cap (set on the
// Roster assign flow, FEAT-11), so program create/update no longer carry
// cap/capPeriod. The programs.cap / programs.cap_period DB columns are
// left dormant (a future migration can drop them).

import { z } from "zod";

export const createProgramSchema = z.object({
  name: z.string().min(1, "name is required").max(200),
  active: z.boolean().optional(),
  // Per-program default pay rate, in integer cents per 30-min slot.
  // null/absent = no rate set ($0 pay until configured). Cap mirrors
  // the per-coach override cap ($1,000 / 30 min). Dollars→cents
  // conversion happens at the form-action layer.
  defaultRatePer30MinCents: z.number().int().min(0).max(1_000_00).nullish(),
});

// All fields optional for partial updates.
export const updateProgramSchema = z.object({
  name: z.string().min(1, "name is required").max(200).optional(),
  active: z.boolean().optional(),
  // null clears the rate back to "no rate set".
  defaultRatePer30MinCents: z.number().int().min(0).max(1_000_00).nullish(),
});

export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
