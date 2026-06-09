// Integration proof for src/db/clear-data.ts against the Neon DEV branch
// (ep-dawn-forest, via INTEGRATION_DATABASE_URL — see setup.ts). This is
// the ONLY place clearData is exercised against a real DB by the worker;
// the Orchestrator runs the CLI against dev then prod.
//
// What it proves:
//   1. clearData wipes EVERY DELETE table to 0 — we first seed a
//      representative graph touching all 14 delete tables.
//   2. clearData leaves EVERY KEEP table untouched (count unchanged) —
//      we seed KEEP rows (coach user, resource, rate_default,
//      org_settings, coach_rate_override) and assert before === after.
//   3. Idempotency: a second clearData run succeeds and DELETE stays 0.
//
// clearData wipes the DELETE tables GLOBALLY (not scoped to our rows),
// which is the whole point. vitest runs test files sequentially, and the
// other suites that seed DELETE-table rows clean themselves up. We
// additionally clean up the KEEP rows we create (afterAll) so we don't
// pollute other suites — they survive the clear (the assertion proves
// it), then we remove them ourselves.

import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  auditLog,
  blockedTimes,
  coachPayments,
  coachPrograms,
  coachRateOverrides,
  hourLogs,
  orgSettings,
  programRateOverrides,
  programScheduleBlocks,
  programScheduleSeries,
  programs,
  rateDefaults,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import {
  clearData,
  countRows,
  DELETE_ORDER,
  KEEP_TABLES,
} from "@/db/clear-data";

const describeIf = process.env.INTEGRATION_DATABASE_URL
  ? describe
  : describe.skip;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// KEEP rows we create and must remove afterwards. clearData is expected
// to leave them untouched, then afterAll deletes them.
const createdUserIds: string[] = [];
const createdResourceIds: string[] = [];
let createdRateDefaultType: "weight_room" | null = null;
let createdOrgSettingsId: string | null = null;

// Seeds a representative graph touching EVERY delete table, plus KEEP
// rows. Returns nothing — the assertions read global counts.
async function seedFullGraph() {
  const s = uniqueSuffix();

  // --- KEEP rows -----------------------------------------------------
  // A coach user (also reused as actor/createdBy throughout the graph).
  const [coach] = await db
    .insert(users)
    .values({
      email: `clear-data-coach-${s}@test.invalid`,
      name: "Clear Data Coach",
      role: "coach",
    })
    .returning({ id: users.id });
  createdUserIds.push(coach.id);

  // A resource (cage) — KEEP, also the FK target for sessions_billing /
  // blocked_times.
  const [resource] = await db
    .insert(resources)
    .values({
      name: `Clear Data Cage ${s}`,
      type: "cage",
      sortOrder: 999_000 + Math.floor(Math.random() * 1000),
      active: true,
    })
    .returning({ id: resources.id });
  createdResourceIds.push(resource.id);

  // A rate_default — KEEP. PK is the resource type, so use weight_room
  // (the session suites use cage/bullpen). onConflictDoNothing keeps the
  // run idempotent if a prior crashed run left it; we only track it for
  // cleanup if WE created it.
  const existingWeightRoom = await db
    .select()
    .from(rateDefaults)
    .where(eq(rateDefaults.type, "weight_room"));
  if (existingWeightRoom.length === 0) {
    await db
      .insert(rateDefaults)
      .values({ type: "weight_room", ratePer30MinCents: 1234 });
    createdRateDefaultType = "weight_room";
  }

  // A coach_rate_override — KEEP.
  await db
    .insert(coachRateOverrides)
    .values({ coachId: coach.id, resourceType: "cage", ratePer30MinCents: 555 })
    .onConflictDoNothing();

  // org_settings — KEEP. Insert a non-default id so we never touch the
  // seeded 'default' row.
  const orgId = `clear-data-${s}`;
  await db
    .insert(orgSettings)
    .values({ id: orgId, pfaDisplayName: "Clear Data Org" });
  createdOrgSettingsId = orgId;

  // --- DELETE rows (all 14 tables) -----------------------------------
  // programs
  const [program] = await db
    .insert(programs)
    .values({ name: `Clear Data Program ${s}`, active: true })
    .returning({ id: programs.id });

  // athletes
  const [athlete] = await db
    .insert(athletes)
    .values({ firstName: `First${s}`, lastName: `Last${s}` })
    .returning({ id: athletes.id });

  // athlete_programs
  await db.insert(athletePrograms).values({
    athleteId: athlete.id,
    programId: program.id,
  });

  // coach_programs
  await db.insert(coachPrograms).values({
    coachId: coach.id,
    programId: program.id,
  });

  // program_rate_overrides
  await db.insert(programRateOverrides).values({
    coachId: coach.id,
    programId: program.id,
    ratePer30MinCents: 777,
  });

  // program_schedule_series + a materialized block (seriesId set)
  const [series] = await db
    .insert(programScheduleSeries)
    .values({
      programId: program.id,
      scheduledCoachId: coach.id,
      daysOfWeek: [1],
      startTime: "09:00",
      endTime: "10:00",
      startsOn: "2099-01-05",
      endsOn: "2099-01-26",
      createdBy: coach.id,
    })
    .returning({ id: programScheduleSeries.id });

  // program_schedule_blocks: one materialized (seriesId) + one one-off.
  await db.insert(programScheduleBlocks).values([
    {
      programId: program.id,
      scheduledCoachId: coach.id,
      startAt: new Date("2099-01-05T14:00:00Z"),
      endAt: new Date("2099-01-05T15:00:00Z"),
      seriesId: series.id,
      createdBy: coach.id,
    },
    {
      programId: program.id,
      scheduledCoachId: coach.id,
      startAt: new Date("2099-01-12T14:00:00Z"),
      endAt: new Date("2099-01-12T15:00:00Z"),
      seriesId: null,
      createdBy: coach.id,
    },
  ]);

  // hour_logs
  await db.insert(hourLogs).values({
    coachId: coach.id,
    programId: program.id,
    startAt: new Date("2026-05-01T14:00:00Z"),
    endAt: new Date("2026-05-01T15:00:00Z"),
    ratePer30MinCents: 100,
    createdBy: coach.id,
  });

  // sessions_billing
  await db.insert(sessionsBilling).values({
    coachId: coach.id,
    resourceId: resource.id,
    startAt: new Date("2026-05-02T14:00:00Z"),
    endAt: new Date("2026-05-02T15:00:00Z"),
    ratePer30MinCents: 200,
    createdBy: coach.id,
  });

  // blocked_times
  await db.insert(blockedTimes).values({
    resourceId: resource.id,
    startAt: new Date("2026-05-03T14:00:00Z"),
    endAt: new Date("2026-05-03T15:00:00Z"),
    reason: "Clear Data block",
    createdBy: coach.id,
  });

  // attendance_sessions + attendance_records
  const [attSession] = await db
    .insert(attendanceSessions)
    .values({
      programId: program.id,
      sessionDate: "2026-05-04",
      createdBy: coach.id,
    })
    .returning({ id: attendanceSessions.id });

  await db.insert(attendanceRecords).values({
    sessionId: attSession.id,
    athleteId: athlete.id,
    present: true,
    recordedBy: coach.id,
  });

  // coach_payments
  await db.insert(coachPayments).values({
    coachId: coach.id,
    amountCents: 5000,
    method: "zelle",
    paidAt: new Date("2026-05-05T00:00:00Z"),
    recordedBy: coach.id,
  });

  // audit_log
  await db.insert(auditLog).values({
    actorUserId: coach.id,
    entityType: "clear_data_test",
    entityId: program.id,
    action: "create",
    diff: { seeded: true },
  });
}

afterAll(async () => {
  // Remove the KEEP rows we created (they survived the clear). Order:
  // children before users. coach_rate_overrides cascades on user delete,
  // but delete it explicitly to be safe and explicit.
  if (createdUserIds.length > 0) {
    await db
      .delete(coachRateOverrides)
      .where(inArray(coachRateOverrides.coachId, createdUserIds));
  }
  if (createdOrgSettingsId) {
    await db.delete(orgSettings).where(eq(orgSettings.id, createdOrgSettingsId));
  }
  if (createdRateDefaultType) {
    await db
      .delete(rateDefaults)
      .where(eq(rateDefaults.type, createdRateDefaultType));
  }
  if (createdResourceIds.length > 0) {
    await db
      .delete(resources)
      .where(inArray(resources.id, createdResourceIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describeIf("clearData (integration, dev branch)", () => {
  it("seeds every DELETE + KEEP table, then clearData zeroes DELETE and leaves KEEP untouched", async () => {
    await seedFullGraph();

    // Sanity: every DELETE table has > 0 rows after seeding.
    for (const t of DELETE_ORDER) {
      expect(await countRows(db, t), `seeded ${t}`).toBeGreaterThan(0);
    }

    const { before, after } = await clearData(db);

    // Every DELETE table is now 0.
    for (const t of DELETE_ORDER) {
      expect(after[t], `after-clear ${t}`).toBe(0);
    }

    // Every KEEP table is unchanged (before === after) and > 0 (we
    // seeded at least one row into each KEEP table, plus pre-existing
    // seed/fixture rows).
    for (const t of KEEP_TABLES) {
      expect(after[t], `keep unchanged ${t}`).toBe(before[t]);
    }
    // The specific KEEP tables we seeded should be non-empty.
    for (const t of [
      "users",
      "resources",
      "rate_defaults",
      "coach_rate_overrides",
      "org_settings",
    ] as const) {
      expect(after[t], `keep non-empty ${t}`).toBeGreaterThan(0);
    }

    // Our specific KEEP rows are still present.
    const survivingUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, createdUserIds));
    expect(survivingUsers.length).toBe(createdUserIds.length);

    const survivingOrg = await db
      .select({ id: orgSettings.id })
      .from(orgSettings)
      .where(eq(orgSettings.id, createdOrgSettingsId!));
    expect(survivingOrg.length).toBe(1);
  });

  it("is idempotent: a second clearData run succeeds and DELETE tables stay 0", async () => {
    const { before, after } = await clearData(db);

    for (const t of DELETE_ORDER) {
      expect(before[t], `2nd-run before ${t}`).toBe(0);
      expect(after[t], `2nd-run after ${t}`).toBe(0);
    }
    for (const t of KEEP_TABLES) {
      expect(after[t], `2nd-run keep unchanged ${t}`).toBe(before[t]);
    }
  });
});
