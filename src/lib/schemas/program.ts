// Zod schemas for program mutations. The program-level session cap was
// removed — the cap is now a PER-ATHLETE enrollment cap (set on the
// Roster assign flow, FEAT-11), so program create/update no longer carry
// cap/capPeriod. The programs.cap / programs.cap_period DB columns are
// left dormant (a future migration can drop them).
//
// 0052 — PROGRAM-LEVEL PAY MODE. A program can now pay a flat amount PER
// LOGGED SESSION instead of by duration. Mirrors the per-(coach, program)
// override shape and the coach-pay-settings schema, including the
// cross-field rule: choosing "per_session" REQUIRES an amount. That rule is
// what stops a program being flipped to per-session and silently paying $0.

import { z } from "zod";

export const programPayModeSchema = z.enum(["hourly", "per_session"]);

// Shared by create + update. Cents; the dollars→cents conversion happens at
// the form-action layer. Cap matches the per-coach per-session cap ($10,000)
// — a single session fee, not an hourly rate, so it needs more headroom than
// the per-30-min cap.
const perSessionCents = z
  .number()
  .int("Per-session amount must be a whole number of cents")
  .positive("Per-session amount must be greater than $0")
  .max(1_000_000, "Per-session amount can't exceed $10,000")
  .nullable()
  .optional();

/**
 * "per_session mode requires an amount" — applied to both create and update.
 * On UPDATE, payMode may be absent (partial update); only enforce when the
 * caller explicitly sets per_session, otherwise a partial edit that never
 * mentions pay would fail validation.
 */
function requireAmountWhenPerSession(
  val: { payMode?: "hourly" | "per_session"; defaultPerSessionRateCents?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (val.payMode === "per_session" && val.defaultPerSessionRateCents == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultPerSessionRateCents"],
      message: "Enter a per-session amount when this program pays per session",
    });
  }
}

export const createProgramSchema = z
  .object({
    name: z.string().min(1, "name is required").max(200),
    active: z.boolean().optional(),
    // Per-program default pay rate, in integer cents per 30-min slot.
    // null/absent = no rate set ($0 pay until configured). Cap mirrors
    // the per-coach override cap ($1,000 / 30 min). Dollars→cents
    // conversion happens at the form-action layer.
    defaultRatePer30MinCents: z.number().int().min(0).max(1_000_00).nullish(),
    // Absent → "hourly", so every existing caller keeps working unchanged.
    payMode: programPayModeSchema.optional(),
    defaultPerSessionRateCents: perSessionCents,
  })
  .superRefine(requireAmountWhenPerSession);

// All fields optional for partial updates.
export const updateProgramSchema = z
  .object({
    name: z.string().min(1, "name is required").max(200).optional(),
    active: z.boolean().optional(),
    // null clears the rate back to "no rate set".
    defaultRatePer30MinCents: z.number().int().min(0).max(1_000_00).nullish(),
    payMode: programPayModeSchema.optional(),
    defaultPerSessionRateCents: perSessionCents,
  })
  .superRefine(requireAmountWhenPerSession);

export type CreateProgramInput = z.infer<typeof createProgramSchema>;
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>;
