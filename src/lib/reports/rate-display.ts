// ONE definition of how a cage-side rate is QUOTED. Display only.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `sessions_billing.rate_per_30_min_cents` is stored per 30-MINUTE SLOT, and
// nothing here changes that: no total, no sum, no snapshot is touched. What is
// stored and what is QUOTED are different questions, and the answer to the
// second one had two implementations that disagreed:
//
//   · `report-preview.tsx`'s `RateCell` (shipped): cage and bullpen per 30 min,
//     weight room per HOUR — an explicit unit suffix precisely so a
//     mixed-resource column is never ambiguous.
//   · the payment statement's engine: `ratePerSlotCents * 2` with "/hr" for
//     EVERY resource type.
//
// So the same session's rate read `$22.00 /30 min` on /admin/reports and
// `$44.00/hr` on that coach's printed statement. Two spellings of one rate on a
// money document is the drift this codebase keeps being bitten by, and a printed
// statement is the copy a coach gets to keep.
//
// 🔴 The convention below is `RateCell`'s, unchanged — this file was extracted
// FROM it, not written beside it. `RateCell` now calls in here, which is what
// makes "the statement quotes the rate the Reports screen quotes" true by
// construction rather than by two developers remembering the same rule. A THIRD
// formatter is the thing this module exists to prevent.
//
// ⚠️ Cage-side only. The WORK account has no slot model — program pay is
// per-hour × exact 15-minute-granular duration, or a flat per-session rate — so
// its labels ("/hr", "/session", "No rate") are built in `engine.ts` from
// nullable snapshots and must not be routed through here. A "/30 min" work rate
// would be a unit that ledger never charges in.

// `ResourceType` from `@/lib/billing`, matching `report-preview.tsx` and
// `aggregate.ts` — the pure billing module's own literal union, so this file
// pulls in no Drizzle schema and stays importable from the pure statement
// engine. (`billing.ts` itself is untouched by this feature and must stay so.)
import type { ResourceType } from "@/lib/billing";
import { formatDollarsExact } from "@/lib/format-money";

/**
 * How to QUOTE a per-30-min stored rate for one resource type.
 *
 * Weight-room rates are small enough per slot that a per-slot figure reads as a
 * typo ("$7.00" for a session), so the shipped screen doubles them and says
 * "/hr". Cage and bullpen are quoted at the granularity they are actually billed
 * at, which is also what makes an off-slot booking's arithmetic legible: the
 * amount is the slot count times this figure, exactly.
 *
 * ⚠️ Keyed on `resourceType` ONLY, deliberately — a GROUP weight-room session is
 * still `resourceType: "weight_room"` (group-ness is a separate boolean and only
 * changes which rate was resolved, not the unit it is quoted in), so it lands on
 * "/hr" the same way `RateCell` already put it there.
 */
export function cageRateParts(
  ratePer30MinCents: number,
  resourceType: ResourceType,
): { amountCents: number; unit: "/hr" | "/30 min" } {
  const perHour = resourceType === "weight_room";
  return {
    amountCents: perHour ? ratePer30MinCents * 2 : ratePer30MinCents,
    unit: perHour ? "/hr" : "/30 min",
  };
}

/**
 * The same thing as one string, for surfaces that cannot style the unit
 * separately — the statement's `StatementChargeRow.rateLabel`, which is a plain
 * string by contract so the engine stays pure and the card owns no formatting.
 *
 * The space before the unit is `RateCell`'s rendering (`{money}{" "}<span>`), and
 * it is kept rather than tidied away so the two surfaces read identically.
 *
 * 🔴 A $0 rate still prints "$0.00 /30 min" here, and that is not an oversight:
 * `rate_per_30_min_cents` is NOT NULL, so zero is a deliberate comp, and "No
 * rate" is reserved for the work account's genuinely nullable snapshots. A comp
 * and an unset rate are different facts and a statement may not blur them.
 */
export function cageRateLabel(
  ratePer30MinCents: number,
  resourceType: ResourceType,
): string {
  const { amountCents, unit } = cageRateParts(ratePer30MinCents, resourceType);
  return `${formatDollarsExact(amountCents)} ${unit}`;
}

/**
 * The sentence a reader needs to multiply a cage row out by hand.
 *
 * Lives here beside the unit convention it explains, because the two cannot be
 * allowed to drift: this copy asserts that a slot is 30 minutes and that
 * bookings bill in WHOLE slots, which is the only reason a 47-minute booking
 * charged for 90 minutes is not an overcharge. Without it the statement printed
 * `9:14 – 10:01 AM · $44.00/hr · $66.00` and a coach who works out 47 minutes at
 * $44/hr computes $34.47 and concludes he was billed twice over.
 */
export const CAGE_SLOT_EXPLAINER =
  "A slot is 30 minutes and bookings bill in whole slots — a 9:14 – 10:01 " +
  "booking bills 9:00 – 10:30, or 3 slots. Amount = slots × the rate shown.";
