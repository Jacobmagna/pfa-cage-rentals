// Integration coverage for ADMIN HOUR ENTRY — an admin recording hours on a
// coach's behalf (`logHourForCoachInternal`).
//
// These hit a real Neon dev branch; see tests/integration/setup.ts.
//
// ── 🔴 WHY EVERY TEST GETS ITS OWN CALENDAR DAY ──────────────────────────
// The overlap guard scans `hour_logs` BY COACH across a time window, not by
// program. `truncateMutables()` does not touch `hour_logs`, and every suite in
// this repo shares the same fixture coaches — so a log another test file left
// behind at an overlapping time would make this file's guard fire for a reason
// that has nothing to do with the case under test. That is rule 20 exactly:
// a module that reads across a whole table needs isolation wider than its own
// rows. Each test therefore takes a unique day in a year no other suite uses,
// which makes a collision structurally impossible rather than unlikely, and
// this file still deletes every log and program it creates.
//
// Dates go through `parsePfaInput`: `hour_logs.start_at` and
// `coach_payments.covers_through` are both naive timestamps on PFA wall-clock,
// and the paid-through guard is a comparison between them.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  coachPayments,
  coachStipendEarnings,
  coachStipends,
  hourLogs,
  programScheduleBlocks,
  programs,
  users,
} from "@/db/schema";
import { ZodError } from "zod";
import {
  logHourForCoachInternal,
  logHourInternal,
} from "@/lib/server/hour-log-actions";
import { upsertProgramRateOverrideInternal } from "@/lib/server/program-rate-override-actions";
import { workPayForLog } from "@/lib/billing";
import {
  AdminHourEntryNotConfirmedError,
  HourLogSubjectNotFoundError,
  ProgramInactiveError,
} from "@/lib/errors";
import { payPeriodFor } from "@/lib/pay-period";
import { parsePfaInput } from "@/lib/timezone";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// Breaks the @/lib/authz → @/auth → next-auth import chain, which does not
// resolve under vitest's node environment. The real auth() is never exercised
// here — the internals take a synthetic actor.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

let fixtures: FixtureUsers;
// The full fixture rows: the internals take an `AuthedSession["user"]`, and
// narrowing these to { id, email } would drop `role`/`scheduleAdmin`.
let admin: FixtureUsers["admin"];
let coach: FixtureUsers["coach"];

const createdProgramIds: string[] = [];
const createdBlockIds: string[] = [];

// 2029 is used by no other suite in this repo. Each test claims the next day.
let dayCursor = 0;
function nextDay(): string {
  dayCursor += 1;
  const day = String((dayCursor % 27) + 1).padStart(2, "0");
  const month = String((Math.floor(dayCursor / 27) % 12) + 1).padStart(2, "0");
  return `2029-${month}-${day}`;
}

const at = (date: string, time: string) => parsePfaInput(date, time);

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createProgram(
  over: {
    active?: boolean;
    defaultRatePer30MinCents?: number | null;
    stipendEligible?: boolean;
  } = {},
): Promise<{ id: string; name: string }> {
  const [row] = await db
    .insert(programs)
    .values({
      name: `Admin Hour Entry ${uniqueSuffix()}`,
      active: over.active ?? true,
      defaultRatePer30MinCents: over.defaultRatePer30MinCents ?? null,
      stipendEligible: over.stipendEligible ?? false,
    })
    .returning({ id: programs.id, name: programs.name });
  createdProgramIds.push(row.id);
  return row;
}

/** The rows this file wrote, for the coach fixture, on one program. */
async function logsFor(programId: string) {
  return db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.programId, programId));
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  admin = fixtures.admin;
  coach = fixtures.coach;
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  // 🔴 hour_logs BEFORE programs — `hour_logs.program_id` has no cascade, so
  // deleting the program first dies with a 23503 and fails every test around
  // it (rule 20's second half, learned by the stipend backfill).
  if (createdProgramIds.length > 0) {
    await db
      .delete(hourLogs)
      .where(inArray(hourLogs.programId, createdProgramIds));
  }
  if (createdBlockIds.length > 0) {
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
    createdBlockIds.length = 0;
  }
  if (createdProgramIds.length > 0) {
    await db.delete(programs).where(inArray(programs.id, createdProgramIds));
    createdProgramIds.length = 0;
  }
});

/* ── THE GAP THIS CLOSES ─────────────────────────────────────────────────── */

describe("an admin records hours a coach never logged", () => {
  it("writes a POSTED log whose coach is the subject and whose author is the admin", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();

    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "14:00"),
      note: "Covered the front desk",
    });

    expect(row).toBeDefined();
    // 🔴 The two identities that were the same person on every other path.
    expect(row!.coachId).toBe(coach.id);
    expect(row!.createdBy).toBe(admin.id);
    expect(row!.status).toBe("posted");
    expect(row!.heldReason).toBeNull();
  });

  // The provenance marker, and the reason this feature needed no migration.
  it("leaves createdBy DIFFERENT from coachId, which is what marks it admin-entered", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });
    expect(row!.createdBy).not.toBe(row!.coachId);
  });

  // The control for the test above: without it, "createdBy !== coachId means
  // admin-entered" could be true for the wrong reason — every row in the
  // product has to satisfy the converse.
  it("leaves createdBy EQUAL to coachId when the coach logs it themselves", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    const row = await logHourInternal(coach, {
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
      acknowledgeHold: true,
    });
    expect(row!.createdBy).toBe(row!.coachId);
  });

  // 🔴 POSTS IMMEDIATELY WITH NO BLOCK. On the coach path this exact entry is
  // held as `unscheduled` and waits for an admin. Here the admin IS the author,
  // so holding it would mean asking him to approve his own typing.
  it("posts with no scheduled block at all, where a coach's log would be held", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();

    const adminRow = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });
    expect(adminRow!.status).toBe("posted");

    // Same shape, entered by the coach: held.
    const coachRow = await logHourInternal(coach, {
      programId: program.id,
      startAt: at(day, "14:00"),
      endAt: at(day, "16:00"),
      acknowledgeHold: true,
    });
    expect(coachRow!.status).toBe("held");
    expect(coachRow!.heldReason).toBe("unscheduled");
  });

  // Stamped reviewed so an admin's own entry does not land in the admin's own
  // needs-review queue. Coupled to the overlap guard — see the note in
  // hour-log-actions.ts.
  it("stamps the row reviewed, by the admin", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });
    expect(row!.reviewedAt).not.toBeNull();
    expect(row!.reviewedBy).toBe(admin.id);
  });

  // The headline case: a shift from months ago that nobody ever logged. There
  // was never a date limit on this path to remove — the 14-day bound people
  // remember is on the coach's one-tap confirm cards.
  it("accepts a date months in the past", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at("2029-01-04", "09:00"),
      endAt: at("2029-01-04", "17:00"),
    });
    expect(row!.status).toBe("posted");
  });

  it("records the ADMIN as the audit actor, not the coach", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "hour_log"),
          eq(auditLog.entityId, row!.id),
        ),
      );
    expect(entry).toBeDefined();
    expect(entry.actorUserId).toBe(admin.id);
    expect(entry.action).toBe("create");
  });
});

/* ── PRICING CANNOT FORK ─────────────────────────────────────────────────── */

describe("pay resolves from the SUBJECT, never from the admin typing it in", () => {
  // 🔴 THE TEST THAT CATCHES AN ACTOR/SUBJECT SWAP, and the reason all three
  // rates below differ. If the rate were resolved from the actor, the row
  // would carry the ADMIN's $99; if the override lookup were skipped, it would
  // fall through to the program's $30. Only reading the coach's own override
  // produces $50, so exactly one of three numbers is right and the other two
  // each name a specific defect.
  it("stamps the coach's own override, not the admin's and not the program default", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 3000 });
    const day = nextDay();

    await upsertProgramRateOverrideInternal(admin, {
      coachId: admin.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 9900,
    });
    await upsertProgramRateOverrideInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 5000,
    });

    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });

    expect(row!.ratePer30MinCents).toBe(5000);
    expect(row!.rateSourceKind).toBe("override");
  });

  it("falls back to the program default when the coach has no override", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 3000 });
    const day = nextDay();
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });
    expect(row!.ratePer30MinCents).toBe(3000);
    expect(row!.rateSourceKind).toBe("program_default");
  });

  it("honours the coach's PER-SESSION override, stamped flat", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 3000 });
    const day = nextDay();
    await upsertProgramRateOverrideInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      payMode: "per_session",
      perSessionRateCents: 7500,
    });

    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "14:00"),
    });
    expect(row!.perSessionRateCents).toBe(7500);
    // 📌 THE HOURLY SNAPSHOT RIDES ALONG, AND THAT IS PRE-EXISTING BEHAVIOUR
    // RATHER THAN A DEFECT HERE. `resolveRateCentsForProgram` returns null for
    // a per-session PROGRAM, but this program is hourly and only the OVERRIDE
    // is per-session, so it falls through to the program default. The number
    // is inert: `workPayForLog` reads the per-session snapshot first, so the
    // flat amount is the whole pay. Asserted as it is rather than as it
    // ideally would be — an overstated assertion is a false claim in the
    // codebase wearing a verified test's clothes, and this behaviour is
    // identical on the coach path, which is the property that matters.
    expect(row!.ratePer30MinCents).toBe(3000);
    // What actually decides the money: a flat amount, not 4 hours × anything.
    expect(
      workPayForLog({
        perSessionRateCents: row!.perSessionRateCents,
        startAt: row!.startAt,
        endAt: row!.endAt,
        ratePer30MinCents: row!.ratePer30MinCents,
      }),
    ).toBe(7500);
  });

  // 🔴 THE STRONGEST FORM OF "PRICING CANNOT FORK": the same work, entered by
  // each path, priced identically. Every other test in this block checks one
  // resolver's output; this one checks that the two paths agree, which is the
  // property the shared core exists to guarantee and the one that would break
  // silently if anyone ever wrote a second insert path for admins.
  it("prices identically to the coach's own log for the same work", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 3000 });
    const day = nextDay();
    await upsertProgramRateOverrideInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 5000,
    });

    // Different windows only because an identical one is a true duplicate.
    const byAdmin = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "09:00"),
      endAt: at(day, "11:00"),
    });
    const byCoach = await logHourInternal(coach, {
      programId: program.id,
      startAt: at(day, "13:00"),
      endAt: at(day, "15:00"),
      acknowledgeHold: true,
    });

    expect(byAdmin!.ratePer30MinCents).toBe(byCoach!.ratePer30MinCents);
    expect(byAdmin!.perSessionRateCents).toBe(byCoach!.perSessionRateCents);
    expect(byAdmin!.rateSourceKind).toBe(byCoach!.rateSourceKind);
    expect(byAdmin!.stipendCovered).toBe(byCoach!.stipendCovered);
    // The control: the two rows really did come from different paths, so the
    // equality above is not two readings of one row.
    expect(byAdmin!.createdBy).not.toBe(byCoach!.createdBy);
    expect(byCoach!.status).toBe("held");
  });

  it("records $0 loudly when nothing supplies a rate", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: null });
    const day = nextDay();
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });
    expect(row!.ratePer30MinCents).toBeNull();
    expect(row!.rateSourceKind).toBe("none");
    // 🔴 NOT the same as "covered by stipend" — the two must never read alike.
    expect(row!.stipendCovered).toBe(false);
  });
});

/* ── THE STIPEND EARNS WITHOUT A SIXTH CALL SITE ─────────────────────────── */

describe("stipend coverage on an admin-entered log", () => {
  async function giveStipend(coachId: string, from: Date, amountCents: number) {
    await db.insert(coachStipends).values({
      coachId,
      amountCents,
      effectiveFrom: from,
      createdBy: admin.id,
    });
  }

  it("marks the log covered, stamps NO rate, and earns the period", async () => {
    const program = await createProgram({
      stipendEligible: true,
      defaultRatePer30MinCents: 3000,
    });
    const day = nextDay();
    const start = at(day, "10:00");
    const period = payPeriodFor(start);
    await giveStipend(coach.id, period.fromDate, 250_000);

    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: start,
      endAt: at(day, "14:00"),
    });

    expect(row!.stipendCovered).toBe(true);
    // 🔴 The most expensive defect available here: a covered log that also
    // carries the program's $30 would be paid hourly ON TOP of the stipend,
    // and every gate would stay green because both numbers are real.
    expect(row!.ratePer30MinCents).toBeNull();
    expect(row!.perSessionRateCents).toBeNull();

    const earnings = await db
      .select()
      .from(coachStipendEarnings)
      .where(eq(coachStipendEarnings.coachId, coach.id));
    expect(earnings).toHaveLength(1);
    expect(earnings[0].periodKey).toBe(period.key);
    expect(earnings[0].amountCents).toBe(250_000);
    expect(earnings[0].earnedByHourLogId).toBe(row!.id);
  });

  // The control that makes the test above mean something. Both halves of the
  // coverage rule have to hold; a fixture satisfying only the program half
  // must fall through to the ordinary rate rather than being paid $0.
  it("does NOT cover a coach who is on no stipend, even on an eligible program", async () => {
    const program = await createProgram({
      stipendEligible: true,
      defaultRatePer30MinCents: 3000,
    });
    const day = nextDay();
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });
    expect(row!.stipendCovered).toBe(false);
    expect(row!.ratePer30MinCents).toBe(3000);
  });

  // Backdating is this path's ordinary case, so the period the stipend earns
  // must come from the LOG's date and never from today.
  it("earns the period the WORK falls in, not the period it was entered in", async () => {
    const program = await createProgram({ stipendEligible: true });
    const workDay = "2029-01-08";
    const start = at(workDay, "10:00");
    const period = payPeriodFor(start);
    await giveStipend(coach.id, period.fromDate, 100_000);

    await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: start,
      endAt: at(workDay, "12:00"),
    });

    const earnings = await db
      .select()
      .from(coachStipendEarnings)
      .where(eq(coachStipendEarnings.coachId, coach.id));
    expect(earnings).toHaveLength(1);
    expect(earnings[0].periodKey).toBe(period.key);
    expect(earnings[0].periodKey).not.toBe(payPeriodFor(new Date()).key);
  });
});

/* ── DOUBLE PAY ──────────────────────────────────────────────────────────── */

describe("the double-pay guards", () => {
  it("does not write a second row for an EXACT duplicate", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    const args = {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "14:00"),
    };

    const first = await logHourForCoachInternal(admin, args);
    // 🔴 confirmWarnings is deliberately NOT passed: an exact duplicate must
    // not raise an overlap warning at all, because the unique index already
    // makes it a no-op. Warning here would be a true-sounding reason attached
    // to a case that cannot happen, and confirming through a false warning is
    // how an admin learns to confirm through a real one.
    const second = await logHourForCoachInternal(admin, args);

    expect(second!.id).toBe(first!.id);
    expect(await logsFor(program.id)).toHaveLength(1);
  });

  // An admin entering hours that a coach already sent for approval IS the
  // approval — decision 3 of the feature.
  it("upgrades a HELD duplicate to posted, crediting the admin as reviewer", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    const window = { startAt: at(day, "10:00"), endAt: at(day, "14:00") };

    const held = await logHourInternal(coach, {
      programId: program.id,
      ...window,
      acknowledgeHold: true,
    });
    expect(held!.status).toBe("held");

    const upgraded = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      ...window,
    });

    expect(upgraded!.id).toBe(held!.id);
    expect(upgraded!.status).toBe("posted");
    expect(upgraded!.heldReason).toBeNull();
    expect(upgraded!.reviewedBy).toBe(admin.id);
    expect(await logsFor(program.id)).toHaveLength(1);
  });

  // 🔴 THE ONE THE UNIQUE INDEX CANNOT SEE. Same coach, same day, overlapping
  // but not identical — two payable rows for the same hours, legal by every
  // constraint in the database.
  it("REFUSES a partial overlap until the admin confirms it", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();

    await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });

    let thrown: unknown;
    try {
      await logHourForCoachInternal(admin, {
        coachId: coach.id,
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "14:00"),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AdminHourEntryNotConfirmedError);
    const warnings = (thrown as AdminHourEntryNotConfirmedError).warnings;
    expect(warnings.map((w) => w.kind)).toContain("overlapping_log");
    // Refused BEFORE the write — the second row must not exist.
    expect(await logsFor(program.id)).toHaveLength(1);
  });

  it("writes the overlapping entry once the admin confirms", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });

    const second = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "14:00"),
      confirmWarnings: true,
    });

    expect(second!.status).toBe("posted");
    expect(await logsFor(program.id)).toHaveLength(2);
  });

  it("catches an overlap across a DIFFERENT program", async () => {
    const one = await createProgram({ defaultRatePer30MinCents: 1500 });
    const two = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();

    await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: one.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });

    await expect(
      logHourForCoachInternal(admin, {
        coachId: coach.id,
        programId: two.id,
        startAt: at(day, "12:00"),
        endAt: at(day, "13:00"),
      }),
    ).rejects.toBeInstanceOf(AdminHourEntryNotConfirmedError);
  });

  // 🔴 CONSECUTIVE SHIFTS ARE ORDINARY AND MUST NOT WARN. Half-open overlap:
  // 10–3 followed by 3–6 is two shifts, not a clash. A guard that fires here
  // fires on the common case, and an admin who confirms through it every day
  // confirms through the real one too.
  it("does not warn when a shift starts exactly where another ended", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });

    const second = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "15:00"),
      endAt: at(day, "18:00"),
    });
    expect(second!.status).toBe("posted");
    expect(await logsFor(program.id)).toHaveLength(2);
  });

  // A rejected log is excluded from every pay, report and accountability read,
  // so it cannot be double-paid. Warning about one would be a warning about
  // money that does not exist.
  it("does not warn about a REJECTED overlapping log", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();

    const first = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });
    await db
      .update(hourLogs)
      .set({ status: "rejected" })
      .where(eq(hourLogs.id, first!.id));

    const second = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "11:00"),
      endAt: at(day, "13:00"),
    });
    expect(second!.status).toBe("posted");
  });

  // The control for the test above — the SAME overlap, left posted, must warn.
  // Without it, "rejected does not warn" could pass because the overlap check
  // never ran at all.
  it("DOES warn about the same overlap when the log is still posted", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });
    await expect(
      logHourForCoachInternal(admin, {
        coachId: coach.id,
        programId: program.id,
        startAt: at(day, "11:00"),
        endAt: at(day, "13:00"),
      }),
    ).rejects.toBeInstanceOf(AdminHourEntryNotConfirmedError);
  });

  // A HELD log is not payable yet, but it becomes payable the moment it is
  // approved — so it is exactly the clash an admin should be told about.
  it("DOES warn about a HELD overlapping log", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    await logHourInternal(coach, {
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
      acknowledgeHold: true,
    });
    await expect(
      logHourForCoachInternal(admin, {
        coachId: coach.id,
        programId: program.id,
        startAt: at(day, "11:00"),
        endAt: at(day, "13:00"),
      }),
    ).rejects.toBeInstanceOf(AdminHourEntryNotConfirmedError);
  });

  it("does not warn about ANOTHER coach's overlapping log", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();

    await logHourForCoachInternal(admin, {
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "15:00"),
    });

    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "11:00"),
      endAt: at(day, "13:00"),
    });
    expect(row!.status).toBe("posted");
  });
});

/* ── ALREADY PAID THROUGH ────────────────────────────────────────────────── */

describe("the already-paid-through decision", () => {
  async function recordPayout(over: {
    coversThrough: Date | null;
    direction?: "pfa_to_coach" | "coach_to_pfa";
    status?: "pending" | "confirmed";
    coachId?: string;
  }) {
    await db.insert(coachPayments).values({
      coachId: over.coachId ?? coach.id,
      amountCents: 124_000,
      method: "zelle",
      direction: over.direction ?? "pfa_to_coach",
      status: over.status ?? "confirmed",
      paidAt: at("2029-01-20", "09:00"),
      coversThrough: over.coversThrough,
      recordedBy: admin.id,
    });
  }

  const WORK_DAY = "2029-01-12";

  async function enter(confirm = false) {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    return logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(WORK_DAY, "10:00"),
      endAt: at(WORK_DAY, "12:00"),
      ...(confirm ? { confirmWarnings: true } : {}),
    });
  }

  it("refuses when a payout already covers the day the hours fall on", async () => {
    await recordPayout({ coversThrough: at("2029-01-31", "00:00") });

    let thrown: unknown;
    try {
      await enter();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AdminHourEntryNotConfirmedError);
    expect(
      (thrown as AdminHourEntryNotConfirmedError).warnings.map((w) => w.kind),
    ).toContain("already_paid_through");
  });

  it("proceeds once the admin confirms", async () => {
    await recordPayout({ coversThrough: at("2029-01-31", "00:00") });
    const row = await enter(true);
    expect(row!.status).toBe("posted");
  });

  it("says nothing when the payout stops before the day", async () => {
    await recordPayout({ coversThrough: at("2029-01-11", "00:00") });
    const row = await enter();
    expect(row!.status).toBe("posted");
  });

  // A pending payout is still the admin saying he paid. Pinning `confirmed`
  // here would have made the guard silent against the largest real payout
  // batch in the product's history.
  it("counts a PENDING payout", async () => {
    await recordPayout({
      coversThrough: at("2029-01-31", "00:00"),
      status: "pending",
    });
    await expect(enter()).rejects.toBeInstanceOf(
      AdminHourEntryNotConfirmedError,
    );
  });

  // Untagged money is counted in no period, and inferring a coverage date from
  // `paid_at` is the guess the column exists to prevent.
  it("ignores a payout with no covers-through date", async () => {
    await recordPayout({ coversThrough: null });
    const row = await enter();
    expect(row!.status).toBe("posted");
  });

  // A coach paying PFA for cage rentals settles nothing about work pay.
  it("ignores a payment in the other direction", async () => {
    await recordPayout({
      coversThrough: at("2029-01-31", "00:00"),
      direction: "coach_to_pfa",
    });
    const row = await enter();
    expect(row!.status).toBe("posted");
  });

  it("ignores another coach's payout", async () => {
    await recordPayout({
      coversThrough: at("2029-01-31", "00:00"),
      coachId: fixtures.flaggedCoach.id,
    });
    const row = await enter();
    expect(row!.status).toBe("posted");
  });

  // Both conditions at once is not exotic — it is what a second pass over a
  // paper timesheet looks like — and the admin has to see BOTH before he
  // confirms, not one and then the other.
  it("returns BOTH warnings together when both apply", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    await recordPayout({ coversThrough: at("2029-01-31", "00:00") });
    await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(WORK_DAY, "10:00"),
      endAt: at(WORK_DAY, "15:00"),
      confirmWarnings: true,
    });

    let thrown: unknown;
    try {
      await logHourForCoachInternal(admin, {
        coachId: coach.id,
        programId: program.id,
        startAt: at(WORK_DAY, "10:00"),
        endAt: at(WORK_DAY, "14:00"),
      });
    } catch (err) {
      thrown = err;
    }
    const kinds = (
      thrown as AdminHourEntryNotConfirmedError
    ).warnings.map((w) => w.kind);
    expect(kinds).toContain("overlapping_log");
    expect(kinds).toContain("already_paid_through");
  });
});

/* ── WHO THE HOURS CAN BE RECORDED FOR ───────────────────────────────────── */

describe("the subject must be a live account", () => {
  it("refuses an unknown coach id", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    await expect(
      logHourForCoachInternal(admin, {
        coachId: "not-a-real-user-id",
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "12:00"),
      }),
    ).rejects.toBeInstanceOf(HourLogSubjectNotFoundError);
  });

  it("refuses a soft-deleted account", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, fixtures.flaggedCoach.id));
    try {
      await expect(
        logHourForCoachInternal(admin, {
          coachId: fixtures.flaggedCoach.id,
          programId: program.id,
          startAt: at(day, "10:00"),
          endAt: at(day, "12:00"),
        }),
      ).rejects.toBeInstanceOf(HourLogSubjectNotFoundError);
    } finally {
      await db
        .update(users)
        .set({ deletedAt: null })
        .where(eq(users.id, fixtures.flaggedCoach.id));
    }
  });

  it("rejects a missing coachId at the schema boundary", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const day = nextDay();
    await expect(
      logHourForCoachInternal(admin, {
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "12:00"),
      }),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

/* ── RETIRED PROGRAMS ────────────────────────────────────────────────────── */

describe("a program that has since been retired", () => {
  it("is accepted on the admin path", async () => {
    const program = await createProgram({
      active: false,
      defaultRatePer30MinCents: 1500,
    });
    const day = nextDay();
    const row = await logHourForCoachInternal(admin, {
      coachId: coach.id,
      programId: program.id,
      startAt: at(day, "10:00"),
      endAt: at(day, "12:00"),
    });
    expect(row!.status).toBe("posted");
    expect(row!.ratePer30MinCents).toBe(1500);
  });

  // 🔴 THE REGRESSION GUARD. Relaxing the active check for admins must not
  // relax it for coaches — that gate is what stops anyone starting to log
  // against a retired program.
  it("is still REFUSED when the coach logs it themselves", async () => {
    const program = await createProgram({
      active: false,
      defaultRatePer30MinCents: 1500,
    });
    const day = nextDay();
    await expect(
      logHourInternal(coach, {
        programId: program.id,
        startAt: at(day, "10:00"),
        endAt: at(day, "12:00"),
        acknowledgeHold: true,
      }),
    ).rejects.toBeInstanceOf(ProgramInactiveError);
  });
});
