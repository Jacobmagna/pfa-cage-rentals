// `0q` RELEASE 1 — THE PAY REPORT SAYS "NOT ON SCHEDULE", END TO END.
//
// ── What happened (Sept 13 2026) ─────────────────────────────────────────
// The Work tab Mark pays from showed $900 against $500–600 correct. Coaches had
// logged hours against schedule blocks; the blocks were then DELETED; the logs
// stayed posted and paid — correctly, a delete is a statement about the plan,
// not about the work — but the report rendered a row with no block EXACTLY like
// a row that matched its block perfectly (both had a blank Schedule cell).
//
// ── What this file proves, through the app's own write paths (rule 33) ────
//   1. Blocks are created by `createProgramScheduleBlockInternal`, logs are
//      posted by a COACH through `logHourInternal` (the real held-then-approve
//      gate classifies each one clean against its block), and the blocks are
//      removed by `deleteProgramScheduleBlockInternal` — no raw SQL writes of
//      hour logs or blocks anywhere in this file.
//   2. After the delete, `fetchHourLogRowsWithScheduleNotes` →
//      `buildWorkReport` marks EXACTLY the four left-behind rows (Spencer's two
//      Summer rows, Asher's two) and leaves the five still-scheduled rows
//      unmarked.
//   3. The grand total and every per-coach pay figure are IDENTICAL before and
//      after the delete — the mark is a fact about the schedule, never a change
//      to pay.
//   4. The printed statement path (Q1, 2026-10-14: no marks on the coach's
//      document) hands `buildWorkReport` rows with `unscheduled: false` even
//      for rows the pay report marks, and the statement data is identical
//      before and after the delete.
//
// Year 2039 is claimed by no other suite. Every fixture name carries
// `uniqueSuffix()` (rule 57). Teardown is scoped by PROGRAM, in FK order:
// hour_logs → blocks → programs → audit_log → users (rules 20, 47, 51).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programScheduleBlocks,
  programs,
  users,
  type User,
} from "@/db/schema";
import { fetchHourLogRowsWithScheduleNotes } from "@/lib/reports/hour-log-fetch";
import { buildWorkReport } from "@/lib/reports/work-report";
import {
  logHourForCoachInternal,
  logHourInternal,
} from "@/lib/server/hour-log-actions";
import {
  createProgramScheduleBlockInternal,
  deleteProgramScheduleBlockInternal,
} from "@/lib/server/program-schedule-actions";
import { fetchStatementCoaches } from "@/lib/statement/fetch";
import { formatPfaDate, parsePfaInput } from "@/lib/timezone";
import { ensureFixtureUsers, type FixtureUsers } from "./fixtures";

// Breaks the @/lib/authz → @/auth → next-auth import chain (unresolvable under
// vitest's node environment). The internals take a real actor row.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

// A transparent pass-through spy, so the statement test can read the rows the
// statement path hands the builder. Behaviour is the real function's.
vi.mock("@/lib/reports/work-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports/work-report")>();
  return { ...actual, buildWorkReport: vi.fn(actual.buildWorkReport) };
});

const DAY = "2039-09-13";
const at = (time: string) => parsePfaInput(DAY, time);
/** $25 per 30 min = $50/hr, so a 2-hour log pays $100 — Sept 13's figure. */
const RATE_PER_30_MIN = 2_500;

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let admin: FixtureUsers["admin"];
let spencer: User;
let mike: User;
let asher: User;
let fall: string;
let summer: string;

const createdProgramIds: string[] = [];
const createdUserIds: string[] = [];
const createdBlockIds: string[] = [];
const createdLogIds: string[] = [];

/** Log ids by name, so assertions read as the Sept 13 table. */
const logId: Record<string, string> = {};
const blockId: Record<string, string> = {};

async function createCoach(name: string): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      email: `not-on-schedule-${uniqueSuffix()}@test.invalid`,
      name: `${name} ${uniqueSuffix()}`,
      role: "coach",
    })
    .returning();
  createdUserIds.push(row.id);
  return row;
}

async function createProgram(label: string): Promise<string> {
  const [row] = await db
    .insert(programs)
    .values({
      name: `0q ${label} ${uniqueSuffix()}`,
      active: true,
      defaultRatePer30MinCents: RATE_PER_30_MIN,
    })
    .returning({ id: programs.id });
  createdProgramIds.push(row.id);
  return row.id;
}

async function block(
  name: string,
  programId: string,
  coaches: User[],
  start: string,
  end: string,
) {
  const row = await createProgramScheduleBlockInternal(admin, {
    programId,
    scheduledCoachIds: coaches.map((c) => c.id),
    startAt: at(start),
    endAt: at(end),
  });
  createdBlockIds.push(row.id);
  blockId[name] = row.id;
}

/** A COACH logs their own hours through the real write path. */
async function coachLogs(
  name: string,
  coach: User,
  programId: string,
  start: string,
  end: string,
) {
  const row = await logHourInternal(coach, {
    programId,
    startAt: at(start),
    endAt: at(end),
  });
  createdLogIds.push(row.id);
  logId[name] = row.id;
  // The real gate classified it clean against its block, so it posted.
  expect(row.status, `${name} should post clean`).toBe("posted");
}

function filters() {
  return {
    from: DAY,
    to: DAY,
    fromDate: at("00:00"),
    toDateExclusive: parsePfaInput("2039-09-14", "00:00"),
    coachIds: [spencer.id, mike.id, asher.id],
    programId: undefined,
    isFiltered: true,
  };
}

async function workReportNow() {
  return buildWorkReport(await fetchHourLogRowsWithScheduleNotes(filters()));
}

function payByCoach(report: Awaited<ReturnType<typeof workReportNow>>) {
  return Object.fromEntries(report.summary.map((s) => [s.coachId, s.payCents]));
}

beforeAll(async () => {
  admin = (await ensureFixtureUsers()).admin;
  spencer = await createCoach("Spencer Marsten");
  mike = await createCoach("Mike Cervantes");
  asher = await createCoach("Asher Stolberg");
  fall = await createProgram("Fall Travelball - Game");
  summer = await createProgram("Summer Travelball - Game");

  // ── The schedule as it stood when the coaches logged ──
  // Fall (these SURVIVE the delete)
  await block("F1", fall, [spencer, mike], "13:00", "15:00");
  await block("F2", fall, [mike], "15:00", "17:00");
  await block("F3", fall, [spencer, mike], "17:00", "19:00");
  // Summer + Asher's morning (these get DELETED)
  await block("S1", summer, [spencer], "13:00", "15:00");
  await block("S2", summer, [spencer], "17:00", "19:00");
  await block("A1", fall, [asher], "09:00", "11:00");
  await block("A2", fall, [asher], "09:00", "10:00");

  // ── Nine logs, each posted clean by the coach against its block ──
  await coachLogs("asher-9-11", asher, fall, "09:00", "11:00");
  await coachLogs("asher-9-10", asher, fall, "09:00", "10:00");
  await coachLogs("mike-13", mike, fall, "13:00", "15:00");
  await coachLogs("mike-15", mike, fall, "15:00", "17:00");
  await coachLogs("mike-17", mike, fall, "17:00", "19:00");
  await coachLogs("spencer-summer-13", spencer, summer, "13:00", "15:00");
  await coachLogs("spencer-fall-13", spencer, fall, "13:00", "15:00");
  await coachLogs("spencer-summer-17", spencer, summer, "17:00", "19:00");
  await coachLogs("spencer-fall-17", spencer, fall, "17:00", "19:00");
});

afterAll(async () => {
  // 🔴 FK order. hour_logs.program_id and program_schedule_blocks.program_id
  // have no cascade, so both go BY PROGRAM before the programs (rules 20, 47).
  if (createdProgramIds.length > 0) {
    await db.delete(hourLogs).where(inArray(hourLogs.programId, createdProgramIds));
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.programId, createdProgramIds));
    await db.delete(programs).where(inArray(programs.id, createdProgramIds));
  }
  // audit_log.actor_user_id references users — this file's coaches wrote
  // their own log-create rows, and the admin wrote the block rows.
  const entityIds = [...createdBlockIds, ...createdLogIds];
  if (createdUserIds.length > 0 || entityIds.length > 0) {
    await db
      .delete(auditLog)
      .where(
        or(
          createdUserIds.length > 0
            ? inArray(auditLog.actorUserId, createdUserIds)
            : undefined,
          entityIds.length > 0 ? inArray(auditLog.entityId, entityIds) : undefined,
        ),
      );
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("🔴 0q — the Sept 13 shape: delete the blocks, the pay report says so", () => {
  it("marks exactly the left-behind rows, and no pay figure moves", async () => {
    // ── BEFORE: every row is on the schedule (the control) ──
    const before = await workReportNow();
    expect(before.detail).toHaveLength(9);
    expect(before.detail.filter((d) => d.unscheduled)).toHaveLength(0);
    for (const s of before.summary) {
      expect(s.unscheduledCount, s.coachName).toBe(0);
    }
    const statementBefore = await fetchStatementCoaches({
      coachIds: [spencer.id, mike.id, asher.id],
    });

    // ── Mark deletes the blocks, through the real delete action ──
    for (const name of ["S1", "S2", "A1", "A2"]) {
      await deleteProgramScheduleBlockInternal(admin, blockId[name]);
    }
    // The delete really happened, and the logs really stayed.
    const remaining = await db
      .select({ id: programScheduleBlocks.id })
      .from(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.programId, createdProgramIds));
    expect(remaining.map((b) => b.id).sort()).toEqual(
      [blockId.F1, blockId.F2, blockId.F3].sort(),
    );

    // ── AFTER ──
    const after = await workReportNow();
    expect(after.detail).toHaveLength(9);

    const marked = after.detail
      .filter((d) => d.unscheduled)
      .map((d) => d.id)
      .sort();
    expect(marked).toEqual(
      [
        logId["asher-9-11"],
        logId["asher-9-10"],
        logId["spencer-summer-13"],
        logId["spencer-summer-17"],
      ].sort(),
    );
    // The still-scheduled five are NOT marked (named, so a wrong extra mark
    // fails with the row's name rather than a count).
    for (const name of [
      "mike-13",
      "mike-15",
      "mike-17",
      "spencer-fall-13",
      "spencer-fall-17",
    ]) {
      const row = after.detail.find((d) => d.id === logId[name])!;
      expect(row.unscheduled, name).toBe(false);
    }
    // Coaches posted these themselves; nobody has reviewed them yet.
    expect(after.detail.every((d) => d.reviewedOn === null)).toBe(true);

    const count = (coach: User) =>
      after.summary.find((s) => s.coachId === coach.id)!;
    expect(count(spencer).unscheduledCount).toBe(2);
    expect(count(asher).unscheduledCount).toBe(2);
    expect(count(mike).unscheduledCount).toBe(0);

    // ── 🔴 NO PAY FIGURE MOVED ──
    expect(after.grandTotalCents).toBe(before.grandTotalCents);
    expect(after.grandTotalHours).toBe(before.grandTotalHours);
    expect(payByCoach(after)).toEqual(payByCoach(before));
    // The figures themselves: Spencer 4 × $100, Mike 3 × $100, Asher $100 + $50.
    expect(payByCoach(after)).toEqual({
      [spencer.id]: 40_000,
      [mike.id]: 30_000,
      [asher.id]: 15_000,
    });
    expect(after.grandTotalCents).toBe(85_000);

    // ── The statement data is identical before and after the delete ──
    const statementAfter = await fetchStatementCoaches({
      coachIds: [spencer.id, mike.id, asher.id],
    });
    expect(statementAfter).toEqual(statementBefore);
  });

  it("🔴 Q1 — the statement path hands the builder unscheduled: false, even for rows the pay report marks", async () => {
    // Runs after the delete above. Control: the pay-report path DOES see the
    // four rows as off-schedule right now.
    const payReport = await workReportNow();
    const markedIds = payReport.detail.filter((d) => d.unscheduled).map((d) => d.id);
    expect(markedIds).toHaveLength(4);

    const spy = vi.mocked(buildWorkReport);
    spy.mockClear();
    await fetchStatementCoaches({ coachIds: [spencer.id, mike.id, asher.id] });
    expect(spy).toHaveBeenCalledTimes(1);
    const passed = spy.mock.calls[0][0];
    // Every one of this file's nine logs reached the statement builder…
    const ours = passed.filter((r) => createdLogIds.includes(r.id));
    expect(ours).toHaveLength(9);
    // …including the four the pay report marks…
    expect(ours.filter((r) => markedIds.includes(r.id))).toHaveLength(4);
    // …and every one says unscheduled: false, explicitly (not undefined).
    for (const r of ours) {
      expect(r.unscheduled, r.id).toBe(false);
    }
  });
});

/* ── Review round 1 (2026-10-14) ─────────────────────────────────────────── */

/** An ADMIN records hours for a coach, through the real admin entry path. */
async function adminRecords(
  coach: User,
  programId: string,
  startAt: Date,
  endAt: Date,
) {
  const result = await logHourForCoachInternal(admin, {
    coachIds: [coach.id],
    programId,
    startAt,
    endAt,
  });
  const [row] = result.logs;
  createdLogIds.push(row.id);
  if (result.schedule.kind === "created" || result.schedule.kind === "joined") {
    createdBlockIds.push(result.schedule.blockId);
  }
  return { row, schedule: result.schedule };
}

function reportFor(day: string, coaches: User[]) {
  return fetchHourLogRowsWithScheduleNotes({
    from: day,
    to: day,
    fromDate: parsePfaInput(day, "00:00"),
    toDateExclusive: new Date(
      parsePfaInput(day, "00:00").getTime() + 24 * 3_600_000,
    ),
    coachIds: coaches.map((c) => c.id),
    programId: undefined,
    isFiltered: true,
  }).then((rows) => buildWorkReport(rows));
}

describe("🔴 0q review — a row an admin entered (so already REVIEWED) still reads Not on schedule once its block is deleted", () => {
  it("is marked, carries its review date, is counted, and moves no money", async () => {
    // 2039-09-20 — its own day. (Sept 2039 is PDT, so the 24h window below is
    // exactly one PFA day.)
    const day = "2039-09-20";
    const dom = await createCoach("Dom Cervantes");
    const created = await createProgramScheduleBlockInternal(admin, {
      programId: fall,
      scheduledCoachIds: [dom.id],
      startAt: parsePfaInput(day, "10:00"),
      endAt: parsePfaInput(day, "12:00"),
    });
    createdBlockIds.push(created.id);

    // Mark records the 2 hours on the block — the admin path stamps the row
    // reviewed at insert (hour-log-actions.ts `reviewStamp`).
    const { row, schedule } = await adminRecords(
      dom,
      fall,
      parsePfaInput(day, "10:00"),
      parsePfaInput(day, "12:00"),
    );
    expect(row.status).toBe("posted");
    expect(row.reviewedAt).not.toBeNull();
    // The block already had Dom on it, so the sync left the schedule alone.
    expect(schedule.kind).toBe("unchanged");
    const reviewedOn = formatPfaDate(row.reviewedAt!);

    const before = await reportFor(day, [dom]);
    expect(before.detail).toHaveLength(1);
    expect(before.detail[0].unscheduled).toBe(false);
    expect(before.summary[0].unscheduledCount).toBe(0);

    // Somebody deletes the block, through the real delete action.
    await deleteProgramScheduleBlockInternal(admin, created.id);

    const after = await reportFor(day, [dom]);
    expect(after.detail).toHaveLength(1);
    const [d] = after.detail;
    // 🔴 Marked — the review stamp does not hide it…
    expect(d.unscheduled).toBe(true);
    // …and the review DATE travels with it, for the gray line under the pill.
    expect(d.reviewedOn).toBe(reviewedOn);
    expect(after.summary[0].unscheduledCount).toBe(1);
    // Money unchanged: 2h × $50/hr.
    expect(after.grandTotalCents).toBe(before.grandTotalCents);
    expect(after.summary[0].payCents).toBe(before.summary[0].payCents);
    expect(after.grandTotalCents).toBe(10_000);
  });
});

describe("🔴 0q review — a log crossing the END of the range is judged against the block that covers its tail", () => {
  it("a block starting at/after the range end still schedules the log (control: the same log with no block is marked)", async () => {
    // Range = 2039-09-27 only. The log runs 11 PM → 1 AM into the 28th; its
    // ONLY covering block is 12 AM–1 AM on the 28th — i.e. it starts exactly
    // at the range's exclusive end, which the old block query cut off.
    const day = "2039-09-27";
    const next = "2039-09-28";
    const eve = await createCoach("Eve Ortega");
    const finn = await createCoach("Finn Park");

    const tail = await createProgramScheduleBlockInternal(admin, {
      programId: fall,
      scheduledCoachIds: [eve.id],
      startAt: parsePfaInput(next, "00:00"),
      endAt: parsePfaInput(next, "01:00"),
    });
    createdBlockIds.push(tail.id);

    const eveLog = await adminRecords(
      eve,
      fall,
      parsePfaInput(day, "23:00"),
      parsePfaInput(next, "01:00"),
    );
    // The sync never moves an existing block's times — the tail block stays
    // 12–1 AM, so the fixture really is the edge case.
    expect(eveLog.schedule.kind).toBe("unchanged");

    // Control: same window, different program (so it cannot join Eve's
    // block). The sync creates a block from the entry; delete it through the
    // real action so this log has NO block at all.
    const finnLog = await adminRecords(
      finn,
      summer,
      parsePfaInput(day, "23:00"),
      parsePfaInput(next, "01:00"),
    );
    expect(finnLog.schedule.kind).toBe("created");
    if (finnLog.schedule.kind === "created") {
      await deleteProgramScheduleBlockInternal(admin, finnLog.schedule.blockId);
    }

    const report = await reportFor(day, [eve, finn]);
    const byId = new Map(report.detail.map((d) => [d.id, d]));
    expect(byId.get(finnLog.row.id)?.unscheduled).toBe(true);
    expect(byId.get(eveLog.row.id)?.unscheduled).toBe(false);
  });
});
