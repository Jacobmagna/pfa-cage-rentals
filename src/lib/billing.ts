// Pure billing helpers. No DB access, no React, no Date.now() — every
// function is deterministic given its inputs so unit tests can cover
// the whole branch space without mocks. Cents discipline: everything
// is integers, dollars never enter this module.
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
// Snapshot rule: every sessions_billing row carries its own
// rate_per_30_min_cents stamped at creation. Reports + admin tables
// + Excel export read THAT, never recompute from current overrides.
// The functions in this file are used at WRITE time (compute the
// rate to stamp), and at TEST time. Display reads use the snapshot.

const SLOT_MINUTES = 30;
const SLOT_MS = SLOT_MINUTES * 60 * 1000;

export type ResourceType = "cage" | "bullpen" | "weight_room";

// Fallback defaults for code paths that don't pass an explicit
// `defaults` argument. These mirror the seed values in the
// `rate_defaults` table — the live values are read from the DB
// in production. Keep aligned with Dad's Excel (verified 2026-05-25).
export const DEFAULT_RATES_PER_SLOT_CENTS: Record<ResourceType, number> = {
  cage: 2200,
  bullpen: 2200,
  weight_room: 700,
};

export type RateOverride = {
  coachId: string;
  resourceType: ResourceType;
  ratePer30MinCents: number;
};

// Program-hour pay: per-PROGRAM default rate + optional per-(coach,
// program) override. Same cents-per-30-min unit as cage sessions, but
// keyed on program rather than resource type.
export type ProgramRateOverride = {
  coachId: string;
  programId: string;
  ratePer30MinCents: number;
};

/**
 * Resolves the cents-per-30-min pay rate for a (coach, program) pair:
 * the (coach, program) override if present, else the program's default,
 * else null. Null means "no rate set" → $0 pay until an admin sets one;
 * callers stamp the null snapshot and read-side math treats it as 0.
 *
 * Linear scan is intentional: the overrides list is small.
 */
export function rateForProgram(
  programId: string,
  coachId: string,
  overrides: ProgramRateOverride[],
  programDefaultCents: number | null,
): number | null {
  const override = overrides.find(
    (o) => o.coachId === coachId && o.programId === programId,
  );
  return override?.ratePer30MinCents ?? programDefaultCents;
}

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
 * pair. Falls back to the supplied `defaults` map (or the module-level
 * DEFAULT_RATES_PER_SLOT_CENTS when omitted).
 *
 * Linear scan is intentional: the overrides list is small.
 */
export function rateForSlot(
  resourceType: ResourceType,
  coachId: string,
  overrides: RateOverride[],
  defaults: Record<ResourceType, number> = DEFAULT_RATES_PER_SLOT_CENTS,
): number {
  const override = overrides.find(
    (o) => o.coachId === coachId && o.resourceType === resourceType,
  );
  return override?.ratePer30MinCents ?? defaults[resourceType];
}

/**
 * Computes the cents-per-30-min-slot rate to STAMP onto a new
 * sessions_billing row: per-coach override → resource-type default.
 */
export function computeRate(args: {
  coachId: string;
  resourceType: ResourceType;
  overrides: RateOverride[];
  defaults?: Record<ResourceType, number>;
}): number {
  return rateForSlot(
    args.resourceType,
    args.coachId,
    args.overrides,
    args.defaults ?? DEFAULT_RATES_PER_SLOT_CENTS,
  );
}

/**
 * Read-path total: multiply a session's snapshotted rate by its slot
 * count. This is what every report + display surface should call —
 * it can NEVER drift from the historical rate, regardless of later
 * override or default changes.
 *
 * CAGE / resource model ONLY (sessions_billing). Program/work pay uses
 * `programPayFromSnapshot` below — do NOT call this for hour_logs.
 */
export function totalFromSnapshot(
  startAt: Date,
  endAt: Date,
  ratePer30MinCents: number,
): number {
  return slotsBetween(startAt, endAt) * ratePer30MinCents;
}

// --- Program / work pay (hour_logs) — true per-hour, exact-minute ---
//
// PROGRAM pay is billed on the EXACT duration of the work block, NOT
// the 30-min cage slot model. Programs went to 15-min granularity in
// P3 #8, so a 45-min block must pay 0.75× the hourly rate, a 90-min
// block 1.5×, etc. These helpers are PROGRAM-ONLY — cage sessions keep
// using slotsBetween / totalFromSnapshot, byte-for-byte unchanged.

/**
 * Exact whole minutes of a program/work block. Blocks are 15-min
 * granular (P3 #8) so this is exact; Math.round absorbs any sub-minute
 * drift. Throws when endAt is not after startAt (a zero/negative-length
 * block is a UI bug — surfacing it is safer than silently billing $0).
 */
export function programMinutes(startAt: Date, endAt: Date): number {
  if (endAt <= startAt) {
    throw new Error("programMinutes: endAt must be after startAt");
  }
  return Math.round((endAt.getTime() - startAt.getTime()) / 60000);
}

/**
 * Program/work PAY: per-hour rate × exact duration, NOT 30-min-slot-
 * rounded. The stored snapshot is per-30-min cents, so
 * per-30 × (minutes/30) = per-hour × hours. A 45-min block at $44/hr
 * (2200 per 30 min) = round(2200 × 45 / 30) = 3300 = $33.00 = 0.75×$44.
 *
 * Historical guarantee: a 30-min-aligned block (minutes a multiple of
 * 30) equals the old `slotsBetween × rate` exactly, so past pay is
 * unchanged. Null snapshot (pre-rate logs) → 0.
 */
export function programPayFromSnapshot(
  startAt: Date,
  endAt: Date,
  ratePer30MinCents: number | null,
): number {
  return Math.round(
    ((ratePer30MinCents ?? 0) * programMinutes(startAt, endAt)) / 30,
  );
}
