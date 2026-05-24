// Pure billing helpers. No DB access, no React, no Date.now() — every
// function is deterministic given its inputs so unit tests in B6 can
// cover the whole branch space without mocks. Cents discipline:
// everything is integers, dollars never enter this module.
//
// Slot model: Dad bills in 30-minute increments per Excel grid. A
// session of any length reserves whole slots ("cage is taken for the
// 9:30 slot regardless of whether the coach finishes at 9:45 or 10:00"),
// so partial slots round outward — startAt floors, endAt ceils.
//
// Timezone: rounding happens in UTC. All US timezones use whole-hour
// offsets, so a local 9:00 boundary is also a UTC 30-min boundary and
// the math stays correct. If PFA ever opens in India (UTC+5:30) or
// Newfoundland (UTC-3:30), revisit with local-time rounding.
//
// Types here will be superseded by Zod-derived types in Stage C once
// the DB schema for sessions / rate overrides lands (C2–C4). Keeping
// them inline for now so B6's tests can land before that schema work.

const SLOT_MINUTES = 30;
const SLOT_MS = SLOT_MINUTES * 60 * 1000;

export type ResourceType = "cage" | "bullpen" | "weight_room";

export const DEFAULT_RATES_PER_SLOT_CENTS: Record<ResourceType, number> = {
  cage: 2200,
  bullpen: 2200,
  weight_room: 500,
};

export type RateOverride = {
  coachId: string;
  resourceType: ResourceType;
  ratePer30MinCents: number;
};

export type SessionInput = {
  coachId: string;
  resourceType: ResourceType;
  startAt: Date;
  endAt: Date;
};

export type ChargeBreakdown = {
  slots: number;
  ratePer30MinCents: number;
  totalCents: number;
};

/**
 * Counts billable 30-minute slots between two timestamps. startAt
 * floors to its slot boundary, endAt ceils — a 9:14–10:01 session
 * bills as 9:00–10:30 (3 slots).
 *
 * Throws when endAt is not strictly after startAt. A zero-length
 * "session" is almost certainly a UI bug; surfacing it is safer
 * than silently billing $0.
 */
export function slotsBetween(startAt: Date, endAt: Date): number {
  if (endAt <= startAt) {
    throw new Error("slotsBetween: endAt must be strictly after startAt");
  }
  const startMs = Math.floor(startAt.getTime() / SLOT_MS) * SLOT_MS;
  const endMs = Math.ceil(endAt.getTime() / SLOT_MS) * SLOT_MS;
  return Math.round((endMs - startMs) / SLOT_MS);
}

/**
 * Returns the cents-per-30-min-slot rate for a (coach, resource type)
 * pair. Falls back to DEFAULT_RATES_PER_SLOT_CENTS when no override
 * matches.
 *
 * Linear scan is intentional: the overrides list is small (one row
 * per coach per resource type they have a special rate for, capped
 * by the coach roster size — dozens, not thousands).
 */
export function rateForSlot(
  resourceType: ResourceType,
  coachId: string,
  overrides: RateOverride[],
): number {
  const override = overrides.find(
    (o) => o.coachId === coachId && o.resourceType === resourceType,
  );
  return override?.ratePer30MinCents ?? DEFAULT_RATES_PER_SLOT_CENTS[resourceType];
}

/**
 * Computes the full billing breakdown for one session. Returned shape
 * is what report rows render directly — slot count, the rate that was
 * applied (so the report can flag default vs override), and total in
 * cents.
 */
export function chargeForSession(
  session: SessionInput,
  overrides: RateOverride[],
): ChargeBreakdown {
  const slots = slotsBetween(session.startAt, session.endAt);
  const ratePer30MinCents = rateForSlot(
    session.resourceType,
    session.coachId,
    overrides,
  );
  return {
    slots,
    ratePer30MinCents,
    totalCents: slots * ratePer30MinCents,
  };
}
