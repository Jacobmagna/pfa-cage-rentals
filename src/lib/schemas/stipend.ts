// stipend SPEC §6.2 / §6.3 — the BOUNDARY schemas for the stipend write path.
//
// These validate SHAPE only. Every TEMPORAL rule — the period boundary, the
// forward-only ordering, the §12.4 back-pay confirmation — lives in
// `src/lib/stipend/engine.ts`, because those rules need the coach's existing
// versions and the current pay period to decide, and a zod refinement has
// neither.
//
// ⚠️ This module is imported by client form components, so it must NOT import
// anything that reaches `@/db` — the same constraint documented on
// `schemas/effective-from.ts`. `@/lib/pay-period` is pure and safe; the
// planner in `lib/stipend/engine.ts` is pure too, but the actions module that
// uses it is not, so nothing here imports across that line.

import { z } from "zod";

/**
 * $10,000 per half-month. Not a policy — a fat-finger ceiling, matching the
 * `max(1_000_000)` the per-session amount already uses. Mark's real number is
 * $2,500 (Nick's manager-work stipend).
 */
export const MAX_STIPEND_CENTS = 1_000_000;

/**
 * 🔴 STRICTLY POSITIVE, and this deviates from SPEC §6.3's `>= 0`. See the
 * long note on `planSetStipend`: `resolveStipendCovered` puts a coach on a
 * stipend by the PRESENCE of an amount, so a $0 version would zero the pay on
 * every covered log and then earn nothing — real hours, no pay, every screen
 * internally consistent. Taking a coach off a stipend is `endCoachStipend`,
 * which is explicit and reversible.
 *
 * The rule is stated in BOTH places on purpose. The schema is the boundary the
 * form hits; the planner is the boundary every caller hits, including a future
 * one that does not go through this schema.
 */
export const stipendAmountCentsSchema = z
  .number()
  .int("Stipend must be a whole number of cents")
  .positive("Stipend must be greater than $0")
  .max(MAX_STIPEND_CENTS, "Stipend can't exceed $10,000 per pay period");

/**
 * `confirmBackdate` is a COMMAND FLAG, never stored — the same treatment
 * `repriceConfirmSchema` gives `confirmDecrease`. It rides on the same payload
 * as the data and is stripped from what gets written.
 */
export const setCoachStipendSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  amountCents: stipendAmountCentsSchema,
  /**
   * PFA-midnight on the 1st or the 16th. Coerced (a form sends a string), then
   * checked for period-alignment by the planner, which owns that rule.
   */
  effectiveFrom: z.coerce.date(),
  note: z.string().trim().max(500).nullish(),
  confirmBackdate: z.boolean().optional(),
});

export const endCoachStipendSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  effectiveTo: z.coerce.date(),
  confirmBackdate: z.boolean().optional(),
});

/**
 * Cancelling a stipend that has not started yet. No date and no confirmation:
 * the planner decides WHICH versions qualify (every one whose period has not
 * begun), and there is nothing to confirm because nothing has been earned
 * against them — that is precisely what makes them cancellable.
 */
export const cancelCoachStipendSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
});

export type SetCoachStipendInput = z.infer<typeof setCoachStipendSchema>;
export type EndCoachStipendInput = z.infer<typeof endCoachStipendSchema>;

/**
 * Dollars as typed → whole cents. Returns null for anything that is not a
 * plain amount, so the caller can surface a real message instead of storing a
 * guess.
 *
 * ⚠️ NOT `Math.round(parseFloat(v) * 100)`. That is the obvious version and it
 * is wrong often enough to matter on money — `19.99 * 100` is
 * `1998.9999999999998`, and `2500.10 * 100` is `250009.99999999997`. This
 * splits on the decimal point and works in integers, so what the admin typed
 * is exactly what gets stored.
 *
 * Lives here rather than beside the form action because a `"use server"` file
 * may only export async functions, and because this is the same "shape of the
 * input" concern the schemas above own.
 */
export function dollarsToCents(raw: string): number | null {
  const v = raw.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ""] = v.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
