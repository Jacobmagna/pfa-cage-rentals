// Integration coverage for the WIDENED hour-log coach filter
// (reports-tabs SPEC Phase A: `coachId?: string` → `coachIds: string[]`).
//
// The whole point of the phase is that NOTHING changes for an existing
// caller, so the assertions here are equivalence assertions:
//
//   1. A single-coach filter returns EXACTLY the rows the pre-widening
//      `eq(hour_logs.coach_id, x)` predicate returned — same rows, same
//      order, same field values (a reference query issued with `eq` is
//      compiled in this file and deep-compared).
//   2. An EMPTY coachIds emits no coach predicate: every coach comes back.
//   3. A legacy `?coachId=` link resolves to the identical row set as the
//      canonical `?coachIds=` one.
//   4. The needs-review queue — which builds a SYNTHETIC filter with
//      coachIds: [] and feeds the admin dashboard — still surfaces every
//      coach's unreviewed logs.
//
// These hit a real Neon dev branch; see tests/integration/setup.ts.
// truncateMutables() does NOT touch hour_logs or programs, so this file
// creates its own uniquely-named program and cleans up after itself, and
// every assertion is scoped to the ids it created.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { hourLogs, programs, users } from "@/db/schema";

// Mirrors the alias in `hour-log-fetch.ts` — see the note in the reference
// query below.
const enteredBy = alias(users, "entered_by");
import {
  fetchHourLogRows,
  fetchHourLogRowsWithScheduleNotes,
} from "@/lib/reports/hour-log-fetch";
import {
  hourLogFiltersFromURLSearchParams,
  type NormalizedHourLogFilters,
} from "@/lib/reports/hour-log-filters";
import { fetchNeedsReviewItems } from "@/lib/server/needs-review";
import type { NeedsReviewItem } from "@/app/admin/_components/needs-review-card";
import { ensureFixtureUsers, type FixtureUsers } from "./fixtures";

let fixtures: FixtureUsers;
let programId: string;
const createdLogIds: string[] = [];

// Coach ids under test, in the order the query sorts them (users.name asc:
// "Integration Admin" < "Integration Coach" < "Integration Flagged Coach").
let coachA: string; // Integration Admin
let coachB: string; // Integration Coach
let coachC: string; // Integration Flagged Coach

// A fixed day five days back. Comfortably inside the needs-review window
// (a fixed 2024-01-01 floor through today's PFA end) and far from any
// month boundary the default filter range cares about.
const dayStartUtc = (() => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 5);
  d.setUTCHours(17, 0, 0, 0); // ~9-10 AM Pacific
  return d;
})();

function at(hoursOffset: number): Date {
  return new Date(dayStartUtc.getTime() + hoursOffset * 3_600_000);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Range covering the whole test day, matching what normalizeHourLogFilters
// would produce for from=to=<that day> — but built explicitly so these
// tests don't depend on the PFA-timezone maths under test elsewhere.
const fromDate = new Date(dayStartUtc.getTime() - 24 * 3_600_000);
const toDateExclusive = new Date(dayStartUtc.getTime() + 24 * 3_600_000);

function filters(
  overrides: Partial<NormalizedHourLogFilters> = {},
): NormalizedHourLogFilters {
  return {
    from: ymd(fromDate),
    to: ymd(dayStartUtc),
    fromDate,
    toDateExclusive,
    coachIds: [],
    programId,
    isFiltered: true,
    ...overrides,
  };
}

/**
 * fetchHourLogRows layers `scheduleNote: null` on top of the base select.
 * Drop it so a result can be compared field-for-field against the
 * reference query below.
 */
function withoutScheduleNote<T extends { scheduleNote: unknown }>(
  rows: T[],
): Omit<T, "scheduleNote">[] {
  return rows.map((row) => {
    const copy: Partial<T> = { ...row };
    delete copy.scheduleNote;
    return copy as Omit<T, "scheduleNote">;
  });
}

/**
 * The PRE-WIDENING predicate, reproduced verbatim: a single coach matched
 * with `eq`. The widened code path must return deep-equal rows.
 */
async function referenceSingleCoachRows(coachId: string) {
  return db
    .select({
      id: hourLogs.id,
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      programId: hourLogs.programId,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      note: hourLogs.note,
      reviewedAt: hourLogs.reviewedAt,
      reviewedBy: hourLogs.reviewedBy,
      status: hourLogs.status,
      decisionReason: hourLogs.decisionReason,
      // Added in Phase C so the Reports "Work hours" tab can show a rate
      // and a pay figure — this fetch carried hours only before that.
      // Mirrored here because the comparison below is a DEEP equal: the
      // reference query has to select exactly what the real one selects,
      // or this test fails on column count rather than on behavior.
      ratePer30MinCents: hourLogs.ratePer30MinCents,
      perSessionRateCents: hourLogs.perSessionRateCents,
      // Added with the stipend feature. This test failing on a new column is
      // the mirror working as intended — it is a DEEP equal, so any column the
      // real query gains has to be added here deliberately rather than drifting
      // in unnoticed.
      stipendCovered: hourLogs.stipendCovered,
      // Added with admin hour entry, so the Work Log table can say who wrote a
      // row as opposed to whose hours it records. Mirrored here for the same
      // reason as everything above it: the comparison is a DEEP equal, so a
      // column the real query gains has to be added here deliberately.
      // ⚠️ The LEFT JOIN below is part of what is being mirrored — its absence
      // would change the ROW SET, not just the column list, if `created_by`
      // ever failed to resolve.
      createdBy: hourLogs.createdBy,
      createdByName: enteredBy.name,
      createdByEmail: enteredBy.email,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    .leftJoin(enteredBy, eq(hourLogs.createdBy, enteredBy.id))
    .where(
      and(
        inArray(hourLogs.status, ["posted", "rejected"]),
        gte(hourLogs.startAt, fromDate),
        lt(hourLogs.startAt, toDateExclusive),
        eq(hourLogs.coachId, coachId),
        eq(hourLogs.programId, programId),
      ),
    )
    .orderBy(asc(users.name), asc(hourLogs.startAt));
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  coachA = fixtures.admin.id;
  coachB = fixtures.coach.id;
  coachC = fixtures.flaggedCoach.id;

  const [program] = await db
    .insert(programs)
    .values({
      name: `Filter Widening Program ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      active: true,
    })
    .returning({ id: programs.id });
  programId = program.id;

  // Two logs for coach A (so "one coach" is genuinely a multi-row set and
  // ordering is observable), one each for B and C.
  const rows = await db
    .insert(hourLogs)
    .values([
      {
        coachId: coachA,
        programId,
        startAt: at(0),
        endAt: at(1),
        ratePer30MinCents: 2500,
        createdBy: fixtures.admin.id,
      },
      {
        coachId: coachA,
        programId,
        startAt: at(2),
        endAt: at(3),
        ratePer30MinCents: 2500,
        createdBy: fixtures.admin.id,
      },
      {
        coachId: coachB,
        programId,
        startAt: at(1),
        endAt: at(2),
        ratePer30MinCents: 2500,
        createdBy: fixtures.admin.id,
      },
      {
        coachId: coachC,
        programId,
        startAt: at(4),
        endAt: at(5),
        ratePer30MinCents: 2500,
        createdBy: fixtures.admin.id,
      },
    ])
    .returning({ id: hourLogs.id });
  createdLogIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  if (createdLogIds.length > 0) {
    await db.delete(hourLogs).where(inArray(hourLogs.id, createdLogIds));
  }
  if (programId) {
    await db.delete(programs).where(eq(programs.id, programId));
  }
});

describe("fetchHourLogRows — empty coachIds means ALL coaches", () => {
  it("returns every coach's rows when no coach filter is set", async () => {
    const rows = await fetchHourLogRows(filters({ coachIds: [] }));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.coachId))).toEqual(
      new Set([coachA, coachB, coachC]),
    );
  });

  it("orders by coach name then start, unchanged", async () => {
    const rows = await fetchHourLogRows(filters({ coachIds: [] }));
    expect(rows.map((r) => r.coachId)).toEqual([
      coachA,
      coachA,
      coachB,
      coachC,
    ]);
    expect(rows[0].startAt.getTime()).toBeLessThan(rows[1].startAt.getTime());
  });
});

describe("fetchHourLogRows — single coach is byte-identical to the old eq predicate", () => {
  it("coachIds: [A] deep-equals the pre-widening eq(coach_id, A) query", async () => {
    const widened = await fetchHourLogRows(filters({ coachIds: [coachA] }));
    const reference = await referenceSingleCoachRows(coachA);

    expect(widened).toHaveLength(2);
    expect(widened).toHaveLength(reference.length);
    expect(widened.every((r) => r.scheduleNote === null)).toBe(true);
    expect(withoutScheduleNote(widened)).toEqual(reference);
  });

  it("holds for a single-row coach too", async () => {
    const widened = await fetchHourLogRows(filters({ coachIds: [coachB] }));
    const reference = await referenceSingleCoachRows(coachB);
    expect(widened).toHaveLength(1);
    expect(withoutScheduleNote(widened)).toEqual(reference);
  });

  it("single-coach rows are the exact subset of the unfiltered result", async () => {
    const all = await fetchHourLogRows(filters({ coachIds: [] }));
    const justA = await fetchHourLogRows(filters({ coachIds: [coachA] }));
    expect(justA).toEqual(all.filter((r) => r.coachId === coachA));
  });

  it("scheduleNote variant is identical for a single coach too", async () => {
    const all = await fetchHourLogRowsWithScheduleNotes(
      filters({ coachIds: [] }),
    );
    const justA = await fetchHourLogRowsWithScheduleNotes(
      filters({ coachIds: [coachA] }),
    );
    expect(justA).toEqual(all.filter((r) => r.coachId === coachA));
  });
});

describe("fetchHourLogRows — multi-coach selection", () => {
  it("two coaches return the union, still name-then-start ordered", async () => {
    const rows = await fetchHourLogRows(
      filters({ coachIds: [coachC, coachA] }),
    );
    expect(rows.map((r) => r.coachId)).toEqual([coachA, coachA, coachC]);
  });

  it("all three ids match the unfiltered result exactly", async () => {
    const explicit = await fetchHourLogRows(
      filters({ coachIds: [coachA, coachB, coachC] }),
    );
    const implicit = await fetchHourLogRows(filters({ coachIds: [] }));
    expect(explicit).toEqual(implicit);
  });

  it("a duplicated id does not duplicate rows", async () => {
    const rows = await fetchHourLogRows(
      filters({ coachIds: [coachA, coachA] }),
    );
    expect(rows).toHaveLength(2);
  });

  it("an unknown coach id returns nothing", async () => {
    const rows = await fetchHourLogRows(
      filters({ coachIds: ["no-such-coach"] }),
    );
    expect(rows).toEqual([]);
  });
});

describe("URL back-compat — a legacy ?coachId= link still filters", () => {
  it("legacy coachId and canonical coachIds fetch identical rows", async () => {
    const base = `from=${ymd(fromDate)}&to=${ymd(dayStartUtc)}`;
    const legacy = hourLogFiltersFromURLSearchParams(
      new URLSearchParams(`${base}&coachId=${coachA}`),
    );
    const canonical = hourLogFiltersFromURLSearchParams(
      new URLSearchParams(`${base}&coachIds=${coachA}`),
    );
    expect(legacy.coachIds).toEqual([coachA]);

    const legacyRows = await fetchHourLogRows({ ...legacy, programId });
    const canonicalRows = await fetchHourLogRows({ ...canonical, programId });
    expect(legacyRows).toHaveLength(2);
    expect(legacyRows).toEqual(canonicalRows);

    // …and both match the pre-widening single-coach query.
    const reference = await referenceSingleCoachRows(coachA);
    expect(withoutScheduleNote(legacyRows)).toEqual(reference);
  });
});

// NeedsReviewItem is a union; only the hour-log-derived members carry an
// `id` (the block-accountability ones carry `flagId`/`blockId`). Narrow to
// the members this file created.
type HourLogReviewItem = Extract<NeedsReviewItem, { id: string }>;

function ourReviewItems(items: NeedsReviewItem[]): HourLogReviewItem[] {
  return items.filter(
    (i): i is HourLogReviewItem => "id" in i && createdLogIds.includes(i.id),
  );
}

describe("needs-review queue — the synthetic coachIds: [] filter", () => {
  it("still surfaces unreviewed logs for EVERY coach", async () => {
    const ours = ourReviewItems(await fetchNeedsReviewItems(new Date()));
    // No schedule blocks exist for this program, so all four logs are
    // "unscheduled" — the queue must contain all of them, across coaches.
    expect(ours).toHaveLength(4);
    expect(new Set(ours.map((i) => i.type))).toEqual(new Set(["unscheduled"]));
  });

  it("the queue's row set matches an explicit all-coach fetch", async () => {
    const queueIds = new Set(
      ourReviewItems(await fetchNeedsReviewItems(new Date())).map((i) => i.id),
    );
    const allRows = await fetchHourLogRowsWithScheduleNotes(
      filters({ coachIds: [] }),
    );
    expect(queueIds).toEqual(new Set(allRows.map((r) => r.id)));
  });

  it("a reviewed log drops out, proving the queue is really reading these rows", async () => {
    const target = createdLogIds[0];
    await db
      .update(hourLogs)
      .set({ reviewedAt: new Date(), reviewedBy: fixtures.admin.id })
      .where(eq(hourLogs.id, target));
    try {
      const ourIds = ourReviewItems(
        await fetchNeedsReviewItems(new Date()),
      ).map((i) => i.id);
      expect(ourIds).not.toContain(target);
      expect(ourIds).toHaveLength(3);
    } finally {
      await db
        .update(hourLogs)
        .set({ reviewedAt: null, reviewedBy: null })
        .where(eq(hourLogs.id, target));
    }
  });
});
