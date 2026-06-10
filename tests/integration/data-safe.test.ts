// Integration tests for the Data-Safe Snapshot capability. These hit a
// real Neon dev branch — see vitest.integration.config.ts and
// tests/integration/setup.ts for env wiring (setup.ts copies
// INTEGRATION_DATABASE_URL → DATABASE_URL before `@/db` loads).
//
// Two groups:
//   1. computeAggregates against CONTROLLED fixtures we insert ourselves
//      (the dev branch has no persistent demo data). We pin a fixed past
//      week and assert the de-identified facts + the k-anonymity contract
//      + a PII-safety scan over every returned fact.
//   2. The exporter (pushFacts) against a REAL op_facts table we create on
//      the dev branch via the raw neon() client (the table is intentionally
//      absent from this app's Drizzle schema). Exercises the text→jsonb
//      dims cast and the unique-violation (23505) idempotency path — the
//      exporter uses a plain INSERT (no ON CONFLICT, which would need SELECT
//      privilege the write-only prod role lacks) and dedupes by catching the
//      unique-index violation.
//
// truncateMutables() truncates sessions_billing / blocked_times /
// audit_log / coach_payments / coach_rate_overrides only. hour_logs,
// programs, athletes, athlete_programs, attendance_*, session_cancellations
// and users are NOT truncated, so this suite creates its own rows with
// unique keys and deletes them in afterAll. We scope every assertion to the
// fixed period window so other suites' leftovers can't perturb the counts —
// we place all fixtures in a fixed PAST week no other suite writes to.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { neon } from "@neondatabase/serverless";

import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  hourLogs,
  programs,
  resources,
  sessionCancellations,
  sessionsBilling,
  users,
} from "@/db/schema";

import { computeAggregates } from "@/lib/data-safe/aggregate";
import { pushFacts, type PushContext } from "@/lib/data-safe/exporter";
import { anonId, dimsHash } from "@/lib/data-safe/anonymize";

// aggregate.ts / exporter.ts pull in @/db → @/auth → next-auth, which fails
// to resolve in the vitest node environment. We never exercise real auth
// here, so stubbing @/auth is purely to break that import chain (mirrors the
// other integration suites).
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

// A fixed PAST week, UTC: Mon 2025-03-03 07:00Z → next Mon 2025-03-10 07:00Z.
// Far in the past so no "today"-relative fixture from another suite lands in
// it, and stable across runs.
const periodStart = new Date("2025-03-03T07:00:00.000Z");
const periodEnd = new Date("2025-03-10T07:00:00.000Z");

// Helper: a Date inside the window (day offset 0–6 from Mon).
function inWeek(dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date(periodStart);
  d.setUTCDate(d.getUTCDate() + dayOffset);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const SALT = "test-salt";
const K = 5;

// Fixture ids we create and must clean up (these tables aren't truncated).
let coachAId: string;
let coachBId: string;
let adminId: string;
let resourceId: string;
let programId: string;
let athletePresentId: string;
let athleteAbsentId: string;
let attendanceSessionId: string;
const createdUserIds: string[] = [];
const createdAthleteIds: string[] = [];

beforeAll(async () => {
  const suffix = uniqueSuffix();

  // --- Users: one admin (creator), two coaches ---
  const [admin] = await db
    .insert(users)
    .values({
      email: `ds-admin-${suffix}@pfa.invalid`,
      name: "DS Admin",
      role: "admin",
    })
    .returning({ id: users.id });
  adminId = admin.id;

  const [coachA] = await db
    .insert(users)
    .values({
      email: `ds-coach-a-${suffix}@pfa.invalid`,
      name: "DS Coach Alpha",
      role: "coach",
    })
    .returning({ id: users.id });
  coachAId = coachA.id;

  const [coachB] = await db
    .insert(users)
    .values({
      email: `ds-coach-b-${suffix}@pfa.invalid`,
      name: "DS Coach Beta",
      role: "coach",
    })
    .returning({ id: users.id });
  coachBId = coachB.id;
  createdUserIds.push(adminId, coachAId, coachBId);

  // --- Resource (cage, active) ---
  const [resource] = await db
    .insert(resources)
    .values({
      name: `DS Cage ${suffix}`,
      type: "cage",
      sortOrder: 99000,
      active: true,
    })
    .returning({ id: resources.id });
  resourceId = resource.id;

  // --- Program (active, with a pay rate so program_pay is nonzero) ---
  const [program] = await db
    .insert(programs)
    .values({
      name: `DS Program ${suffix}`,
      active: true,
      defaultRatePer30MinCents: 4000,
    })
    .returning({ id: programs.id });
  programId = program.id;

  // --- sessions_billing: 5 cage bookings in the week (>= k so the
  // per-resource-type dim cell survives k-suppression), rate > 0.
  // 3000c/30min snapshot. slotsBetween(1h) = 2 → totalFromSnapshot = 2*3000.
  // Distinct non-overlapping slots — the resource has an EXCLUDE constraint.
  await db.insert(sessionsBilling).values(
    [0, 1, 2, 3, 4].map((i) => ({
      coachId: i % 2 === 0 ? coachAId : coachBId,
      resourceId,
      startAt: inWeek(i, 18),
      endAt: inWeek(i, 19),
      ratePer30MinCents: 3000,
      createdBy: adminId,
      createdAt: inWeek(i, 9), // booked same day → same_day lead bucket
    })),
  );

  // --- hour_logs: Coach A gets 5 posted logs (>= k), Coach B gets 4 (< k) ---
  const coachAlogs = [0, 1, 2, 3, 4].map((i) => ({
    coachId: coachAId,
    programId,
    startAt: inWeek(i, 10),
    endAt: inWeek(i, 12), // 2h each
    ratePer30MinCents: 4000,
    status: "posted" as const,
    createdBy: coachAId,
  }));
  const coachBlogs = [0, 1, 2, 3].map((i) => ({
    coachId: coachBId,
    programId,
    startAt: inWeek(i, 14),
    endAt: inWeek(i, 15),
    ratePer30MinCents: 4000,
    status: "posted" as const,
    createdBy: coachBId,
  }));
  await db.insert(hourLogs).values([...coachAlogs, ...coachBlogs]);

  // --- session_cancellations: one in the week ---
  await db.insert(sessionCancellations).values({
    sessionId: `ds-cancelled-${suffix}`,
    coachId: coachAId,
    resourceId,
    startAt: inWeek(2, 18),
    endAt: inWeek(2, 19),
    ratePer30MinCents: 3000,
    cancelledAt: inWeek(2, 12),
    cancelledBy: coachAId,
    leadTimeMins: 360,
  });

  // --- attendance: one session, one present + one absent record ---
  const [attSession] = await db
    .insert(attendanceSessions)
    .values({
      programId,
      sessionDate: "2025-03-05", // a Wed inside the week
      createdBy: adminId,
    })
    .returning({ id: attendanceSessions.id });
  attendanceSessionId = attSession.id;

  const [aPresent] = await db
    .insert(athletes)
    .values({ firstName: "DSPresent", lastName: suffix })
    .returning({ id: athletes.id });
  athletePresentId = aPresent.id;
  const [aAbsent] = await db
    .insert(athletes)
    .values({ firstName: "DSAbsent", lastName: suffix })
    .returning({ id: athletes.id });
  athleteAbsentId = aAbsent.id;
  createdAthleteIds.push(athletePresentId, athleteAbsentId);

  // Enroll both with a cap so cap_utilization has a denominator.
  await db.insert(athletePrograms).values([
    { athleteId: athletePresentId, programId, cap: 10, capPeriod: "total" },
    { athleteId: athleteAbsentId, programId, cap: 10, capPeriod: "total" },
  ]);

  await db.insert(attendanceRecords).values([
    {
      sessionId: attendanceSessionId,
      athleteId: athletePresentId,
      present: true,
      recordedBy: adminId,
    },
    {
      sessionId: attendanceSessionId,
      athleteId: athleteAbsentId,
      present: false,
      recordedBy: adminId,
    },
  ]);
});

afterAll(async () => {
  // Delete in FK-safe order. attendance_records cascade off the session;
  // athlete_programs cascade off the program/athletes. Be explicit anyway.
  await db
    .delete(attendanceRecords)
    .where(eq(attendanceRecords.sessionId, attendanceSessionId));
  await db
    .delete(attendanceSessions)
    .where(eq(attendanceSessions.id, attendanceSessionId));
  await db
    .delete(athletePrograms)
    .where(eq(athletePrograms.programId, programId));
  await db.delete(sessionCancellations).where(
    inArray(sessionCancellations.coachId, [coachAId, coachBId]),
  );
  await db.delete(hourLogs).where(eq(hourLogs.programId, programId));
  await db.delete(sessionsBilling).where(eq(sessionsBilling.resourceId, resourceId));
  await db.delete(programs).where(eq(programs.id, programId));
  await db.delete(resources).where(eq(resources.id, resourceId));
  if (createdAthleteIds.length > 0) {
    await db.delete(athletes).where(inArray(athletes.id, createdAthleteIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("computeAggregates against controlled fixtures", () => {
  it("emits facility totals, k-anonymizes coaches, and leaks no PII", async () => {
    const facts = await computeAggregates(db, {
      periodStart,
      periodEnd,
      salt: SALT,
      k: K,
    });

    // --- bookings: facility scalar total > 0 + a per-resource-type dim row.
    const bookingsScalar = facts.find(
      (f) => f.metric === "bookings_count" && !f.dims,
    );
    expect(bookingsScalar).toBeTruthy();
    expect(bookingsScalar!.value).toBeGreaterThan(0);

    const bookingsByType = facts.find(
      (f) =>
        f.metric === "bookings_count" &&
        f.dims != null &&
        f.dims.resource_type !== undefined,
    );
    expect(bookingsByType).toBeTruthy();
    expect(bookingsByType!.dims!.resource_type).toBe("cage");

    // --- cage_revenue_cents > 0 (Σ totalFromSnapshot for our 2 bookings).
    const cageRevenue = facts.find((f) => f.metric === "cage_revenue_cents");
    expect(cageRevenue).toBeTruthy();
    expect(cageRevenue!.value).toBeGreaterThan(0);

    // --- Coach A surfaces under the correct anon token (>= k logs).
    const anonA = anonId(SALT, "coach", coachAId);
    const anonB = anonId(SALT, "coach", coachBId);

    const coachAFact = facts.find(
      (f) =>
        (f.metric === "coach_hours_logged" ||
          f.metric === "coach_sessions_delivered") &&
        f.dims?.anon_coach_id === anonA,
    );
    expect(coachAFact).toBeTruthy();

    // --- Coach B (< k logs) is fully suppressed: NO fact under its token.
    const coachBLeak = facts.find(
      (f) => f.dims?.anon_coach_id === anonB || f.subType === anonB,
    );
    expect(coachBLeak).toBeUndefined();

    // --- No-show count >= 1 and rate in [0, 100].
    const noShowCount = facts.find((f) => f.metric === "no_show_count");
    expect(noShowCount).toBeTruthy();
    expect(noShowCount!.value).toBeGreaterThanOrEqual(1);

    const noShowRate = facts.find((f) => f.metric === "no_show_rate");
    expect(noShowRate).toBeTruthy();
    expect(noShowRate!.value).toBeGreaterThanOrEqual(0);
    expect(noShowRate!.value).toBeLessThanOrEqual(100);

    // --- PII SAFETY: no raw id, name, or email anywhere in any fact.
    const forbidden = [
      coachAId,
      coachBId,
      adminId,
      athletePresentId,
      athleteAbsentId,
      programId,
      resourceId,
      "DS Coach Alpha",
      "DS Coach Beta",
      "DS Admin",
      "pfa.invalid",
      "ds-coach-a",
      "ds-coach-b",
    ];
    for (const fact of facts) {
      const json = JSON.stringify(fact);
      for (const needle of forbidden) {
        expect(json).not.toContain(needle);
      }
    }

    // Sanity: Coach A's anon token IS present (proves the scan above isn't
    // vacuously passing because facts are empty).
    expect(JSON.stringify(facts)).toContain(anonA);
  });
});

describe("pushFacts against a real op_facts table", () => {
  const databaseUrl = process.env.INTEGRATION_DATABASE_URL!;
  const ANON_CLIENT = "__test__";

  const ctx: PushContext = {
    databaseUrl,
    anonClientId: ANON_CLIENT,
    vertical: "facility_baseball",
    periodStart,
    periodEnd,
    sourceRunId: "test-run",
  };

  const facts = [
    {
      metric: "bookings_count",
      value: 7,
      subType: "cage",
      dims: { resource_type: "cage", hour: 18 },
    },
    { metric: "utilization_pct", value: 42.5 },
  ];

  beforeAll(async () => {
    const sql = neon(databaseUrl);
    // DDL copied from Build System/data-safe-store-setup.sql (table + the
    // idempotency unique index). The dev role can read/create here, unlike
    // the write-only prod role.
    await sql`
      CREATE TABLE IF NOT EXISTS op_facts (
        id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        anon_client_id text        NOT NULL,
        vertical       text        NOT NULL,
        sub_type       text,
        period_start   timestamptz NOT NULL,
        period_end     timestamptz NOT NULL,
        metric         text        NOT NULL,
        value          double precision NOT NULL,
        dims           jsonb,
        dims_hash      text        NOT NULL DEFAULT '',
        source_run_id  text        NOT NULL,
        ingested_at    timestamptz NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS op_facts_idem_unique
        ON op_facts (anon_client_id, metric, period_start, period_end, dims_hash)
    `;
    // Clean any leftover rows from a previous interrupted run.
    await sql`DELETE FROM op_facts WHERE anon_client_id = ${ANON_CLIENT}`;
  });

  afterAll(async () => {
    const sql = neon(databaseUrl);
    await sql`DELETE FROM op_facts WHERE anon_client_id = ${ANON_CLIENT}`;
  });

  it("inserts both facts, lands dims as JSONB, and is idempotent on re-push", async () => {
    // First push → both rows newly inserted.
    const first = await pushFacts(facts, ctx);
    expect(first.attempted).toBe(2);
    expect(first.inserted).toBe(2);

    // Read back (dev role can SELECT, unlike the write-only prod role).
    const sql = neon(databaseUrl);
    const rows = (await sql`
      SELECT metric, value, sub_type, dims, dims_hash
      FROM op_facts
      WHERE anon_client_id = ${ANON_CLIENT}
      ORDER BY metric
    `) as Array<{
      metric: string;
      value: number;
      sub_type: string | null;
      dims: Record<string, unknown> | null;
      dims_hash: string;
    }>;
    expect(rows).toHaveLength(2);

    // The dimmed row (bookings_count): dims arrived as JSONB (an object), and
    // dims_hash matches the shared dimsHash of the original dims.
    const dimmed = rows.find((r) => r.metric === "bookings_count")!;
    expect(dimmed.dims).not.toBeNull();
    expect(typeof dimmed.dims).toBe("object");
    expect(dimmed.dims!.resource_type).toBe("cage");
    expect(dimmed.dims!.hour).toBe(18);
    expect(dimmed.dims_hash).not.toBe("");
    expect(dimmed.dims_hash).toBe(
      dimsHash({ resource_type: "cage", hour: 18 }),
    );

    // The dimensionless row (utilization_pct): dims null, dims_hash ''.
    const dimless = rows.find((r) => r.metric === "utilization_pct")!;
    expect(dimless.dims).toBeNull();
    expect(dimless.dims_hash).toBe("");
    expect(dimless.dims_hash).toBe(dimsHash(undefined));

    // Re-push the SAME facts → both INSERTs raise unique-violation (23505),
    // caught as idempotent no-ops → 0 inserted.
    const second = await pushFacts(facts, ctx);
    expect(second.attempted).toBe(2);
    expect(second.inserted).toBe(0);

    // Still exactly 2 rows (no duplicates landed).
    const after = (await sql`
      SELECT count(*)::int AS n FROM op_facts WHERE anon_client_id = ${ANON_CLIENT}
    `) as Array<{ n: number }>;
    expect(after[0].n).toBe(2);
  });
});
