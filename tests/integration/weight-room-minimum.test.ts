// Integration tests for the weight room one-hour minimum, against the real
// dev database.
//
// The rule: a rental on a `weight_room` resource can never be CREATED shorter
// than 60 minutes, and cannot be re-timed or moved while it is shorter than 60
// minutes. Cages and bullpens are untouched. The historical import is exempt.
// The "group session" flag can no longer be set by a new booking.
//
// How this file is built:
//   - EVERY refusal fixture fails for exactly one reason: valid ids, an empty
//     calendar (TRUNCATE before each test), no blocked time. It asserts the
//     error class AND its code, asserts nothing was written, and is followed in
//     the same test by a 60-minute control through the SAME function, so a
//     refusal can never be passing because the function refuses everything.
//   - Old 30-minute weight room rentals are seeded with a direct INSERT, since
//     the create path now refuses them. They are real: the calendar allowed
//     them until this change, and the import still records them.
//   - The edit tests go through the REAL form actions with FormData. Both edit
//     forms always resend the resource, the date and both times, so a test
//     that sent only `{ note }` would never meet the case that matters.
//   - Dollar figures are never read off `rate_defaults` (the test database's
//     weight room default is not production's). A test that asserts a rate sets
//     it itself with a `coach_rate_overrides` row, which IS truncated between
//     tests.
//
// `@/auth` and `next/cache` are mocked at file scope (vi.mock is hoisted), the
// same way master-schedule-actions-authz.test.ts does it.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import ExcelJS from "exceljs";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  coachRateOverrides,
  rateDefaults,
  sessionsBilling,
} from "@/db/schema";
import { totalFromSnapshot } from "@/lib/billing";
import { PastRentalImmutableError, WeightRoomMinimumError } from "@/lib/errors";
import { executeCommitPlan } from "@/lib/server/import-actions";
import {
  createSessionInternal,
  createSessionsBatchInternal,
  updateSessionInternal,
} from "@/lib/server/session-actions";
import { formatPfaDate, formatPfaTime, parsePfaInput } from "@/lib/timezone";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

// The form actions call revalidatePath() after a successful write. Outside a
// Next.js request that throws, which would hide the success being asserted.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

type Row = typeof sessionsBilling.$inferSelect;

const CREATE_MESSAGE = (resourceName: string) =>
  `Weight room rentals are one hour minimum. Book at least 1 hour on ${resourceName}.`;
const UPDATE_MESSAGE =
  "Weight room rentals are one hour minimum. To change the time or spot, make this rental at least 1 hour.";

let fixtures: FixtureUsers;
let seeded: Awaited<ReturnType<typeof getSeededResources>>;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  seeded = await getSeededResources();
});

beforeEach(async () => {
  await truncateMutables();
  authMock.mockReset();
});

// ── helpers ──────────────────────────────────────────────────────────────

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const DAY_MS = 86_400_000;

// A PFA calendar day `offsetDays` from today, as the "YYYY-MM-DD" a date
// input sends. Three days out (or back) keeps every rental clearly future
// (or clearly past) whatever hour the suite runs at.
function pfaDay(offsetDays: number): string {
  return formatPfaDate(new Date(Date.now() + offsetDays * DAY_MS));
}
const FUTURE_DAY = pfaDay(3);
const PAST_DAY = pfaDay(-3);

// The instant of a PFA wall-clock time on a PFA day: exactly what the form
// actions compute from the date and time inputs.
function at(day: string, time: string): Date {
  return parsePfaInput(day, time);
}

function minutes(row: { startAt: Date; endAt: Date }): number {
  return (row.endAt.getTime() - row.startAt.getTime()) / 60_000;
}

function mockAsCoach() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.coach.id,
      email: fixtures.coach.email,
      name: fixtures.coach.name,
      role: "coach",
      scheduleAdmin: false,
    },
  });
}

function mockAsAdmin() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.admin.id,
      email: fixtures.admin.email,
      name: fixtures.admin.name,
      role: "admin",
    },
  });
}

// Runs `fn` and returns what it threw. If it does NOT throw, the test fails
// with a plain assertion saying so, rather than a confusing TypeError from
// reading `.code` off a row that should never have been written.
async function refusal(fn: () => Promise<unknown>): Promise<unknown> {
  let resolved: unknown;
  try {
    resolved = await fn();
  } catch (err) {
    return err;
  }
  expect.fail(
    `expected the write to be refused, but it went through and returned ${JSON.stringify(
      resolved,
    )}`,
  );
}

function expectMinimumRefusal(
  err: unknown,
  context: "create" | "update",
  resourceName: string,
) {
  expect(err).toBeInstanceOf(WeightRoomMinimumError);
  const e = err as WeightRoomMinimumError;
  expect(e.code).toBe("WEIGHT_ROOM_MINIMUM");
  expect(e.name).toBe("WeightRoomMinimumError");
  expect(e.context).toBe(context);
  expect(e.resourceName).toBe(resourceName);
  expect(e.message).toBe(
    context === "create" ? CREATE_MESSAGE(resourceName) : UPDATE_MESSAGE,
  );
}

async function allRows(): Promise<Row[]> {
  return db.select().from(sessionsBilling);
}

async function readRow(id: string): Promise<Row | undefined> {
  const [row] = await db
    .select()
    .from(sessionsBilling)
    .where(eq(sessionsBilling.id, id))
    .limit(1);
  return row;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The form actions return only `{ ok: true }`, not the row, so an allowed
// edit has to be read back. The Neon HTTP driver can serve a read that
// misses a write made a moment earlier, so this re-reads until the row shows
// the expected change (or gives up and returns the last read, which the
// caller's assertions then fail on honestly).
async function readRowUntil(
  id: string,
  shows: (row: Row) => boolean,
): Promise<Row> {
  let last: Row | undefined;
  for (let attempt = 0; attempt < 8; attempt++) {
    last = await readRow(id);
    if (last && shows(last)) return last;
    await sleep(250);
  }
  if (!last) throw new Error(`readRowUntil: rental ${id} not found`);
  return last;
}

// Seeds a rental the way an OLD one looks: written straight to the table,
// never through the create path (which now refuses a short weight room
// rental). The rate is a deliberately odd number so a test can tell "the
// stored rate was kept" from "the rate was looked up again".
async function seedRentalDirect(opts: {
  resourceId: string;
  day: string;
  start: string;
  end: string;
  coachId?: string;
  note?: string | null;
  ratePer30MinCents?: number;
  isGroupSession?: boolean;
}): Promise<Row> {
  const [row] = await db
    .insert(sessionsBilling)
    .values({
      coachId: opts.coachId ?? fixtures.coach.id,
      resourceId: opts.resourceId,
      startAt: at(opts.day, opts.start),
      endAt: at(opts.day, opts.end),
      note: opts.note ?? null,
      ratePer30MinCents: opts.ratePer30MinCents ?? 913,
      isGroupSession: opts.isGroupSession ?? false,
      createdBy: fixtures.admin.id,
    })
    .returning();
  return row;
}

// The batch writes one audit entry, keyed to the first row it returned. It
// is not part of the return value, so it is read back (with the same
// patience as readRowUntil).
async function readBatchAudit(firstSessionId: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, firstSessionId),
          eq(auditLog.action, "create"),
        ),
      );
    if (rows.length > 0) {
      expect(rows).toHaveLength(1);
      return (rows[0].diff as { after: Record<string, unknown> }).after as {
        batch: boolean;
        count: number;
        sessionIds: string[];
        coachId: string;
        resourceIds: string[];
        rows: Array<{ sessionId: string; resourceId: string }>;
      };
    }
    await sleep(250);
  }
  throw new Error(`no batch audit entry found for ${firstSessionId}`);
}

// ── createSessionInternal ────────────────────────────────────────────────

describe("createSessionInternal — weight room one-hour minimum", () => {
  it("refuses a 30-minute weight room rental and writes nothing; 60 minutes goes through", async () => {
    const err = await refusal(() =>
      createSessionInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        resourceId: seeded.weightRoom1.id,
        startAt: at(FUTURE_DAY, "15:00"),
        endAt: at(FUTURE_DAY, "15:30"),
      }),
    );
    expectMinimumRefusal(err, "create", seeded.weightRoom1.name);
    expect(await allRows()).toHaveLength(0);

    // Control: the same call, same spot, same start, one hour long.
    const created = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom1.id,
      startAt: at(FUTURE_DAY, "15:00"),
      endAt: at(FUTURE_DAY, "16:00"),
    });
    expect(created.resourceId).toBe(seeded.weightRoom1.id);
    expect(minutes(created)).toBe(60);
  });

  it("refuses 45 and 59 minutes; exactly 60 is allowed", async () => {
    for (const end of ["15:45", "15:59"]) {
      const err = await refusal(() =>
        createSessionInternal(fixtures.admin, {
          coachId: fixtures.coach.id,
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, end),
        }),
      );
      expectMinimumRefusal(err, "create", seeded.weightRoom1.name);
    }
    expect(await allRows()).toHaveLength(0);

    const created = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom1.id,
      startAt: at(FUTURE_DAY, "15:00"),
      endAt: at(FUTURE_DAY, "16:00"),
    });
    expect(minutes(created)).toBe(60);
  });

  it("names the weight room that was asked for (Weight Room 2)", async () => {
    const err = await refusal(() =>
      createSessionInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        resourceId: seeded.weightRoom2.id,
        startAt: at(FUTURE_DAY, "15:00"),
        endAt: at(FUTURE_DAY, "15:30"),
      }),
    );
    expectMinimumRefusal(err, "create", seeded.weightRoom2.name);
    expect(seeded.weightRoom2.name).toBe("Weight Room 2");
    expect(await allRows()).toHaveLength(0);

    const created = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom2.id,
      startAt: at(FUTURE_DAY, "15:00"),
      endAt: at(FUTURE_DAY, "16:30"),
    });
    expect(minutes(created)).toBe(90);
  });

  it("leaves cages and bullpens alone: a 30-minute rental still saves on each", async () => {
    const cage = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.cage1.id,
      startAt: at(FUTURE_DAY, "15:00"),
      endAt: at(FUTURE_DAY, "15:30"),
    });
    const bullpen = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.bullpen1.id,
      startAt: at(FUTURE_DAY, "15:00"),
      endAt: at(FUTURE_DAY, "15:30"),
    });
    expect(minutes(cage)).toBe(30);
    expect(cage.resourceId).toBe(seeded.cage1.id);
    expect(minutes(bullpen)).toBe(30);
    expect(bullpen.resourceId).toBe(seeded.bullpen1.id);
  });
});

// ── createSessionsBatchInternal ──────────────────────────────────────────

describe("createSessionsBatchInternal — back-to-back weight room slots save as one rental", () => {
  it("two back-to-back slots on one weight room save as ONE 60-minute row, and the audit entry says one", async () => {
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
          note: "Smith",
        },
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
          note: "Jones",
        },
      ],
    });

    expect(inserted).toHaveLength(1);
    const [row] = inserted;
    expect(row.resourceId).toBe(seeded.weightRoom1.id);
    expect(row.startAt.getTime()).toBe(at(FUTURE_DAY, "15:00").getTime());
    expect(row.endAt.getTime()).toBe(at(FUTURE_DAY, "16:00").getTime());
    expect(minutes(row)).toBe(60);
    expect(row.note).toBe("Smith / Jones");

    const audit = await readBatchAudit(row.id);
    expect(audit.batch).toBe(true);
    expect(audit.count).toBe(1);
    expect(audit.sessionIds).toEqual([row.id]);
    expect(audit.rows).toEqual([
      { sessionId: row.id, resourceId: seeded.weightRoom1.id },
    ]);
  });

  it("three back-to-back slots save as one 90-minute row", async () => {
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom1.id,
      slots: [
        { startAt: at(FUTURE_DAY, "15:00"), endAt: at(FUTURE_DAY, "15:30") },
        { startAt: at(FUTURE_DAY, "15:30"), endAt: at(FUTURE_DAY, "16:00") },
        { startAt: at(FUTURE_DAY, "16:00"), endAt: at(FUTURE_DAY, "16:30") },
      ],
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].startAt.getTime()).toBe(
      at(FUTURE_DAY, "15:00").getTime(),
    );
    expect(inserted[0].endAt.getTime()).toBe(at(FUTURE_DAY, "16:30").getTime());
    expect(minutes(inserted[0])).toBe(90);
    expect(inserted[0].note).toBeNull();
  });

  it("back-to-back slots given in reverse order still merge", async () => {
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
      ],
    });

    expect(inserted).toHaveLength(1);
    expect(inserted[0].startAt.getTime()).toBe(
      at(FUTURE_DAY, "15:00").getTime(),
    );
    expect(inserted[0].endAt.getTime()).toBe(at(FUTURE_DAY, "16:00").getTime());
  });

  it("refuses a lone 30-minute weight room slot and writes nothing; a lone 60-minute slot goes through", async () => {
    const err = await refusal(() =>
      createSessionsBatchInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        slots: [
          {
            resourceId: seeded.weightRoom1.id,
            startAt: at(FUTURE_DAY, "15:00"),
            endAt: at(FUTURE_DAY, "15:30"),
          },
        ],
      }),
    );
    expectMinimumRefusal(err, "create", seeded.weightRoom1.name);
    expect(await allRows()).toHaveLength(0);

    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
      ],
    });
    expect(inserted).toHaveLength(1);
    expect(minutes(inserted[0])).toBe(60);
  });

  it("3:00 and 4:00 on the same weight room are two lone picks: refused, nothing written", async () => {
    const err = await refusal(() =>
      createSessionsBatchInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        resourceId: seeded.weightRoom1.id,
        slots: [
          { startAt: at(FUTURE_DAY, "15:00"), endAt: at(FUTURE_DAY, "15:30") },
          { startAt: at(FUTURE_DAY, "16:00"), endAt: at(FUTURE_DAY, "16:30") },
        ],
      }),
    );
    expectMinimumRefusal(err, "create", seeded.weightRoom1.name);
    expect(await allRows()).toHaveLength(0);

    // Control: fill the gap and the same picks become one 90-minute rental.
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom1.id,
      slots: [
        { startAt: at(FUTURE_DAY, "15:00"), endAt: at(FUTURE_DAY, "15:30") },
        { startAt: at(FUTURE_DAY, "16:00"), endAt: at(FUTURE_DAY, "16:30") },
        { startAt: at(FUTURE_DAY, "15:30"), endAt: at(FUTURE_DAY, "16:00") },
      ],
    });
    expect(inserted).toHaveLength(1);
    expect(minutes(inserted[0])).toBe(90);
  });

  it("adjacent times on Weight Room 1 and Weight Room 2 do NOT merge: each needs its own hour", async () => {
    const err = await refusal(() =>
      createSessionsBatchInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        slots: [
          {
            resourceId: seeded.weightRoom1.id,
            startAt: at(FUTURE_DAY, "15:00"),
            endAt: at(FUTURE_DAY, "15:30"),
          },
          {
            resourceId: seeded.weightRoom2.id,
            startAt: at(FUTURE_DAY, "15:30"),
            endAt: at(FUTURE_DAY, "16:00"),
          },
        ],
      }),
    );
    // The first row checked is the Weight Room 1 pick.
    expectMinimumRefusal(err, "create", seeded.weightRoom1.name);
    expect(await allRows()).toHaveLength(0);

    // Control: give each weight room its own hour and both save, one row each.
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
        {
          resourceId: seeded.weightRoom2.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
        {
          resourceId: seeded.weightRoom2.id,
          startAt: at(FUTURE_DAY, "16:00"),
          endAt: at(FUTURE_DAY, "16:30"),
        },
      ],
    });
    expect(inserted).toHaveLength(2);
    const wr1 = inserted.find((r) => r.resourceId === seeded.weightRoom1.id)!;
    const wr2 = inserted.find((r) => r.resourceId === seeded.weightRoom2.id)!;
    expect(minutes(wr1)).toBe(60);
    expect(wr1.startAt.getTime()).toBe(at(FUTURE_DAY, "15:00").getTime());
    expect(minutes(wr2)).toBe(60);
    expect(wr2.startAt.getTime()).toBe(at(FUTURE_DAY, "15:30").getTime());
  });

  it("a cage slot plus a lone weight room slot: refused, and ZERO rows are written, the cage included", async () => {
    const cageSlot = {
      resourceId: seeded.cage1.id,
      startAt: at(FUTURE_DAY, "15:00"),
      endAt: at(FUTURE_DAY, "15:30"),
    };
    const err = await refusal(() =>
      createSessionsBatchInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        slots: [
          // The cage slot is first, so it has already passed its own checks
          // by the time the weight room slot is refused.
          cageSlot,
          {
            resourceId: seeded.weightRoom1.id,
            startAt: at(FUTURE_DAY, "15:00"),
            endAt: at(FUTURE_DAY, "15:30"),
          },
        ],
      }),
    );
    expectMinimumRefusal(err, "create", seeded.weightRoom1.name);
    expect(await allRows()).toHaveLength(0);

    // Control: the same cage slot with a full weight room hour saves both.
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        cageSlot,
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
      ],
    });
    expect(inserted).toHaveLength(2);
    expect(
      minutes(inserted.find((r) => r.resourceId === seeded.cage1.id)!),
    ).toBe(30);
    expect(
      minutes(inserted.find((r) => r.resourceId === seeded.weightRoom1.id)!),
    ).toBe(60);
  });

  it("cages in the same batch still save one row per 30-minute slot; the audit entry and the returned rows match what was saved", async () => {
    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      slots: [
        {
          resourceId: seeded.cage1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
        {
          resourceId: seeded.cage1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
        {
          resourceId: seeded.bullpen1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
        {
          resourceId: seeded.bullpen1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
      ],
    });

    // Six taps: two cage rows, ONE weight room row, two bullpen rows.
    expect(inserted).toHaveLength(5);
    const cageRows = inserted.filter((r) => r.resourceId === seeded.cage1.id);
    const bullpenRows = inserted.filter(
      (r) => r.resourceId === seeded.bullpen1.id,
    );
    const wrRows = inserted.filter(
      (r) => r.resourceId === seeded.weightRoom1.id,
    );
    expect(cageRows.map(minutes)).toEqual([30, 30]);
    expect(bullpenRows.map(minutes)).toEqual([30, 30]);
    expect(wrRows.map(minutes)).toEqual([60]);

    // The returned array is the rows saved, no more and no fewer.
    const saved = await allRows();
    expect(saved).toHaveLength(inserted.length);
    expect(new Set(saved.map((r) => r.id))).toEqual(
      new Set(inserted.map((r) => r.id)),
    );

    // The audit entry counts rows saved, not slots tapped.
    const audit = await readBatchAudit(inserted[0].id);
    expect(audit.count).toBe(5);
    expect(audit.sessionIds).toEqual(inserted.map((r) => r.id));
    expect(audit.rows).toEqual(
      inserted.map((r) => ({ sessionId: r.id, resourceId: r.resourceId })),
    );
    expect(audit.rows).toHaveLength(5);
    expect(new Set(audit.resourceIds)).toEqual(
      new Set([seeded.cage1.id, seeded.weightRoom1.id, seeded.bullpen1.id]),
    );
  });

  it("money: the one merged hour carries the coach's rate and bills exactly what two separate half-hours bill", async () => {
    // Set the rate here. 950 is neither the test database's weight room
    // default nor production's, so it can only have come from this row.
    await db.insert(coachRateOverrides).values({
      coachId: fixtures.coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 950,
    });

    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom1.id,
      slots: [
        { startAt: at(FUTURE_DAY, "15:00"), endAt: at(FUTURE_DAY, "15:30") },
        { startAt: at(FUTURE_DAY, "15:30"), endAt: at(FUTURE_DAY, "16:00") },
      ],
    });
    expect(inserted).toHaveLength(1);
    const merged = inserted[0];
    expect(merged.ratePer30MinCents).toBe(950);
    expect(merged.isGroupSession).toBe(false);

    // Two separate 30-minute rows at the same rate, the way the calendar
    // saved the same two taps before this change (written directly, on the
    // other weight room so they cannot collide with the merged row).
    const halves = [
      await seedRentalDirect({
        resourceId: seeded.weightRoom2.id,
        day: FUTURE_DAY,
        start: "15:00",
        end: "15:30",
        ratePer30MinCents: 950,
      }),
      await seedRentalDirect({
        resourceId: seeded.weightRoom2.id,
        day: FUTURE_DAY,
        start: "15:30",
        end: "16:00",
        ratePer30MinCents: 950,
      }),
    ];
    const apart = halves.reduce(
      (sum, r) => sum + totalFromSnapshot(r.startAt, r.endAt, r.ratePer30MinCents),
      0,
    );
    const together = totalFromSnapshot(
      merged.startAt,
      merged.endAt,
      merged.ratePer30MinCents,
    );

    expect(together).toBe(apart);
    // $19.00 for the hour: two half-hours at $9.50.
    expect(together).toBe(1900);
  });
});

// ── create through the real forms ────────────────────────────────────────

describe("create through the real form actions", () => {
  function createForm(fields: {
    coachId?: string;
    resourceId: string;
    day: string;
    start: string;
    end: string;
  }): FormData {
    const fd = new FormData();
    if (fields.coachId) fd.set("coachId", fields.coachId);
    fd.set("resourceId", fields.resourceId);
    fd.set("date", fields.day);
    fd.set("startTime", fields.start);
    fd.set("endTime", fields.end);
    fd.set("note", "");
    return fd;
  }

  it("coach form (logOwnSessionFormAction): 30 minutes on a weight room returns the refusal as a message, not a throw", async () => {
    mockAsCoach();
    const { logOwnSessionFormAction } = await import(
      "@/app/coach/sessions/new/form-actions"
    );

    const refused = await logOwnSessionFormAction(
      { ok: true, loggedAt: 0 },
      createForm({
        resourceId: seeded.weightRoom1.id,
        day: FUTURE_DAY,
        start: "15:00",
        end: "15:30",
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("WEIGHT_ROOM_MINIMUM");
    expect(refused.error.message).toBe(CREATE_MESSAGE(seeded.weightRoom1.name));
    // The form gets its own values back so the coach does not retype them.
    expect(refused.values.resourceId).toBe(seeded.weightRoom1.id);
    expect(refused.values.endTime).toBe("15:30");
    expect(await allRows()).toHaveLength(0);

    // Control: the same form, one hour.
    const saved = await logOwnSessionFormAction(
      { ok: true, loggedAt: 0 },
      createForm({
        resourceId: seeded.weightRoom1.id,
        day: FUTURE_DAY,
        start: "15:00",
        end: "16:00",
      }),
    );
    expect(saved.ok).toBe(true);
  });

  it("admin form (createSessionFormAction): 30 minutes on a weight room returns the refusal as a message, not a throw", async () => {
    mockAsAdmin();
    const { createSessionFormAction } = await import(
      "@/app/admin/sessions/form-actions"
    );

    const refused = await createSessionFormAction(
      { ok: true },
      createForm({
        coachId: fixtures.coach.id,
        resourceId: seeded.weightRoom1.id,
        day: FUTURE_DAY,
        start: "15:00",
        end: "15:30",
      }),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    expect(refused.error.code).toBe("WEIGHT_ROOM_MINIMUM");
    expect(refused.error.message).toBe(CREATE_MESSAGE(seeded.weightRoom1.name));
    expect(refused.values.coachId).toBe(fixtures.coach.id);
    expect(await allRows()).toHaveLength(0);

    const saved = await createSessionFormAction(
      { ok: true },
      createForm({
        coachId: fixtures.coach.id,
        resourceId: seeded.weightRoom1.id,
        day: FUTURE_DAY,
        start: "15:00",
        end: "16:00",
      }),
    );
    expect(saved).toEqual({ ok: true });
  });
});

// ── update through the real forms ────────────────────────────────────────
//
// Both edit dialogs post the same fields every time: id, resource, date,
// start, end, note (and, on the admin one, the coach). So "a note-only edit"
// is a form that resends the stored resource, date and times unchanged with a
// different note. `editForm` builds exactly that from the stored row, and each
// test overrides only what its edit changes.

type EditOverrides = {
  resourceId?: string;
  start?: string;
  end?: string;
  note?: string;
  coachId?: string;
};

type EditResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string } };

type EditDriver = {
  label: string;
  actAs: () => void;
  submit: (row: Row, changes: EditOverrides) => Promise<EditResult>;
};

function editFields(row: Row, changes: EditOverrides): FormData {
  const fd = new FormData();
  fd.set("id", row.id);
  fd.set("resourceId", changes.resourceId ?? row.resourceId);
  fd.set("date", formatPfaDate(row.startAt));
  fd.set("startTime", changes.start ?? formatPfaTime(row.startAt));
  fd.set("endTime", changes.end ?? formatPfaTime(row.endAt));
  fd.set("note", changes.note ?? row.note ?? "");
  return fd;
}

const coachEdit: EditDriver = {
  label: "coach edit form (updateOwnSessionFormAction)",
  actAs: mockAsCoach,
  submit: async (row, changes) => {
    const { updateOwnSessionFormAction } = await import(
      "@/app/coach/sessions/form-actions"
    );
    return updateOwnSessionFormAction({ ok: true }, editFields(row, changes));
  },
};

const adminEdit: EditDriver = {
  label: "admin edit form (updateSessionFormAction)",
  actAs: mockAsAdmin,
  submit: async (row, changes) => {
    const { updateSessionFormAction } = await import(
      "@/app/admin/sessions/form-actions"
    );
    const fd = editFields(row, changes);
    fd.set("coachId", changes.coachId ?? row.coachId);
    return updateSessionFormAction({ ok: true }, fd);
  },
};

function expectRefusedState(result: EditResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe("WEIGHT_ROOM_MINIMUM");
  expect(result.error.message).toBe(UPDATE_MESSAGE);
}

async function expectUntouched(before: Row) {
  const after = await readRow(before.id);
  expect(after).toBeDefined();
  expect(after!.resourceId).toBe(before.resourceId);
  expect(after!.startAt.getTime()).toBe(before.startAt.getTime());
  expect(after!.endAt.getTime()).toBe(before.endAt.getTime());
  expect(after!.note).toBe(before.note);
  expect(after!.coachId).toBe(before.coachId);
  expect(after!.ratePer30MinCents).toBe(before.ratePer30MinCents);
  expect(after!.updatedAt.getTime()).toBe(before.updatedAt.getTime());
}

describe.each([coachEdit, adminEdit])("update through the $label", (driver) => {
  beforeEach(() => {
    driver.actAs();
  });

  it("a note-only edit of an OLD 30-minute weight room rental is allowed (same resource, date and times resent)", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
      note: "before",
    });
    expect(minutes(old)).toBe(30);

    const result = await driver.submit(old, { note: "after" });
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(old.id, (r) => r.note === "after");
    expect(row.note).toBe("after");
    // Still the same 30 minutes, on the same spot, at the same stored rate.
    expect(row.resourceId).toBe(seeded.weightRoom1.id);
    expect(row.startAt.getTime()).toBe(old.startAt.getTime());
    expect(row.endAt.getTime()).toBe(old.endAt.getTime());
    expect(row.ratePer30MinCents).toBe(old.ratePer30MinCents);
  });

  it("a note-only edit of an OLD 30-minute weight room rental in the PAST is allowed too", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: PAST_DAY,
      start: "15:00",
      end: "15:30",
      note: "before",
    });
    expect(old.startAt.getTime()).toBeLessThan(Date.now());

    const result = await driver.submit(old, { note: "after" });
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(old.id, (r) => r.note === "after");
    expect(row.note).toBe("after");
    expect(row.startAt.getTime()).toBe(old.startAt.getTime());
    expect(row.endAt.getTime()).toBe(old.endAt.getTime());
  });

  it("re-timing an old 30-minute weight room rental while it is still 30 minutes is refused; lengthening it to 60 is allowed", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });

    const refused = await driver.submit(old, { start: "16:00", end: "16:30" });
    expectRefusedState(refused);
    await expectUntouched(old);

    // Control, same form: keep the start, move the end out to a full hour.
    const allowed = await driver.submit(old, { end: "16:00" });
    expect(allowed).toEqual({ ok: true });
    const row = await readRowUntil(old.id, (r) => minutes(r) === 60);
    expect(minutes(row)).toBe(60);
    expect(row.startAt.getTime()).toBe(old.startAt.getTime());
    expect(row.endAt.getTime()).toBe(at(FUTURE_DAY, "16:00").getTime());
    // A time edit never re-prices: the stored rate is kept.
    expect(row.ratePer30MinCents).toBe(old.ratePer30MinCents);
  });

  it("stretching an old 30-minute weight room rental to 45 minutes is still refused", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });

    const refused = await driver.submit(old, { end: "15:45" });
    expectRefusedState(refused);
    await expectUntouched(old);

    const allowed = await driver.submit(old, { end: "16:00" });
    expect(allowed).toEqual({ ok: true });
    const row = await readRowUntil(old.id, (r) => minutes(r) === 60);
    expect(minutes(row)).toBe(60);
  });

  it("moving an old 30-minute weight room rental to Weight Room 2 while it is 30 minutes is refused; moving it AND making it an hour is allowed", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });

    const refused = await driver.submit(old, {
      resourceId: seeded.weightRoom2.id,
    });
    expectRefusedState(refused);
    await expectUntouched(old);

    const allowed = await driver.submit(old, {
      resourceId: seeded.weightRoom2.id,
      end: "16:00",
    });
    expect(allowed).toEqual({ ok: true });
    const row = await readRowUntil(
      old.id,
      (r) => r.resourceId === seeded.weightRoom2.id,
    );
    expect(row.resourceId).toBe(seeded.weightRoom2.id);
    expect(minutes(row)).toBe(60);
  });

  it("shortening a 60-minute weight room rental to 30 minutes is refused; shortening a 90-minute one to 60 is allowed", async () => {
    const hour = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "16:00",
    });
    const refused = await driver.submit(hour, { end: "15:30" });
    expectRefusedState(refused);
    await expectUntouched(hour);

    const ninety = await seedRentalDirect({
      resourceId: seeded.weightRoom2.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "16:30",
    });
    const allowed = await driver.submit(ninety, { end: "16:00" });
    expect(allowed).toEqual({ ok: true });
    const row = await readRowUntil(ninety.id, (r) => minutes(r) === 60);
    expect(minutes(row)).toBe(60);
  });

  it("a 60-minute weight room rental moved to a cage is allowed", async () => {
    const hour = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "16:00",
    });

    const result = await driver.submit(hour, { resourceId: seeded.cage1.id });
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(
      hour.id,
      (r) => r.resourceId === seeded.cage1.id,
    );
    expect(row.resourceId).toBe(seeded.cage1.id);
    expect(minutes(row)).toBe(60);
  });

  it("an old 30-minute weight room rental moved to a cage is allowed (the final spot is not a weight room)", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });

    const result = await driver.submit(old, { resourceId: seeded.cage1.id });
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(
      old.id,
      (r) => r.resourceId === seeded.cage1.id,
    );
    expect(row.resourceId).toBe(seeded.cage1.id);
    expect(minutes(row)).toBe(30);
  });

  it("a 30-minute cage rental moved to a weight room is refused; a 60-minute cage rental moved there is allowed", async () => {
    const shortCage = await seedRentalDirect({
      resourceId: seeded.cage1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });
    const refused = await driver.submit(shortCage, {
      resourceId: seeded.weightRoom1.id,
    });
    expectRefusedState(refused);
    await expectUntouched(shortCage);

    const hourCage = await seedRentalDirect({
      resourceId: seeded.cage2.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "16:00",
    });
    const allowed = await driver.submit(hourCage, {
      resourceId: seeded.weightRoom1.id,
    });
    expect(allowed).toEqual({ ok: true });
    const row = await readRowUntil(
      hourCage.id,
      (r) => r.resourceId === seeded.weightRoom1.id,
    );
    expect(row.resourceId).toBe(seeded.weightRoom1.id);
    expect(minutes(row)).toBe(60);
  });

  it("a 30-minute cage rental can still be re-timed and stay 30 minutes (cages are untouched)", async () => {
    const cage = await seedRentalDirect({
      resourceId: seeded.cage1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });

    const result = await driver.submit(cage, { start: "16:00", end: "16:30" });
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(
      cage.id,
      (r) => r.startAt.getTime() === at(FUTURE_DAY, "16:00").getTime(),
    );
    expect(row.startAt.getTime()).toBe(at(FUTURE_DAY, "16:00").getTime());
    expect(minutes(row)).toBe(30);
  });
});

describe("update — what only the admin form can do", () => {
  beforeEach(() => {
    mockAsAdmin();
  });

  it("reassigning an old 30-minute weight room rental to another coach is allowed, length unchanged", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
      note: "keep me",
    });

    const result = await adminEdit.submit(old, {
      coachId: fixtures.flaggedCoach.id,
    });
    expect(result).toEqual({ ok: true });

    const row = await readRowUntil(
      old.id,
      (r) => r.coachId === fixtures.flaggedCoach.id,
    );
    expect(row.coachId).toBe(fixtures.flaggedCoach.id);
    expect(row.resourceId).toBe(seeded.weightRoom1.id);
    expect(row.startAt.getTime()).toBe(old.startAt.getTime());
    expect(row.endAt.getTime()).toBe(old.endAt.getTime());
    expect(minutes(row)).toBe(30);
    expect(row.note).toBe("keep me");
  });

  it("re-timing an old 30-minute weight room rental in the PAST while it is still 30 minutes is refused; lengthening it to 60 is allowed", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: PAST_DAY,
      start: "15:00",
      end: "15:30",
    });

    const refused = await adminEdit.submit(old, {
      start: "16:00",
      end: "16:30",
    });
    expectRefusedState(refused);
    await expectUntouched(old);

    const allowed = await adminEdit.submit(old, { end: "16:00" });
    expect(allowed).toEqual({ ok: true });
    const row = await readRowUntil(old.id, (r) => minutes(r) === 60);
    expect(minutes(row)).toBe(60);
  });
});

describe("update — the coach form's own rule about PAST rentals (unchanged by this work)", () => {
  // src/app/coach/sessions/actions.ts refuses a coach changing the resource
  // or times of a rental that has already started, BEFORE the write function
  // (and so before the one-hour rule) is reached. That error is not in the
  // coach form's list of errors it turns into a message, so the form action
  // throws it. Pinned here as the code stands; not part of this change.
  it("a coach re-timing a PAST 30-minute weight room rental hits the past-rental rule first, and it is thrown, not returned", async () => {
    mockAsCoach();
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: PAST_DAY,
      start: "15:00",
      end: "15:30",
    });

    const err = await refusal(() =>
      coachEdit.submit(old, { start: "16:00", end: "17:00" }),
    );
    expect(err).toBeInstanceOf(PastRentalImmutableError);
    expect((err as PastRentalImmutableError).code).toBe(
      "PAST_RENTAL_IMMUTABLE",
    );
    await expectUntouched(old);
  });
});

describe("updateSessionInternal — the rule compares VALUES, not which fields were sent", () => {
  it("resending the stored resource and times as fresh Date objects with a new note is a note-only edit", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
      note: "before",
    });

    const updated = await updateSessionInternal(fixtures.admin, old.id, {
      resourceId: old.resourceId,
      // Equal instants, different objects: an identity check would call
      // these "changed".
      startAt: new Date(old.startAt.getTime()),
      endAt: new Date(old.endAt.getTime()),
      note: "after",
    });
    expect(updated.note).toBe("after");
    expect(minutes(updated)).toBe(30);
    expect(updated.ratePer30MinCents).toBe(old.ratePer30MinCents);
  });

  it("sending ONLY a new end time on an old 30-minute rental is judged on the final length: 45 refused, 60 allowed", async () => {
    const old = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });

    const err = await refusal(() =>
      updateSessionInternal(fixtures.admin, old.id, {
        endAt: at(FUTURE_DAY, "15:45"),
      }),
    );
    expectMinimumRefusal(err, "update", seeded.weightRoom1.name);
    await expectUntouched(old);

    const updated = await updateSessionInternal(fixtures.admin, old.id, {
      endAt: at(FUTURE_DAY, "16:00"),
    });
    expect(minutes(updated)).toBe(60);
  });

  it("sending ONLY a new resource: a 30-minute cage rental to a weight room is refused, a 60-minute one is allowed", async () => {
    const shortCage = await seedRentalDirect({
      resourceId: seeded.cage1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "15:30",
    });
    const err = await refusal(() =>
      updateSessionInternal(fixtures.admin, shortCage.id, {
        resourceId: seeded.weightRoom2.id,
      }),
    );
    expectMinimumRefusal(err, "update", seeded.weightRoom2.name);
    await expectUntouched(shortCage);

    const hourCage = await seedRentalDirect({
      resourceId: seeded.cage2.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "16:00",
    });
    const updated = await updateSessionInternal(fixtures.admin, hourCage.id, {
      resourceId: seeded.weightRoom2.id,
    });
    expect(updated.resourceId).toBe(seeded.weightRoom2.id);
    expect(minutes(updated)).toBe(60);
  });
});

// ── the group flag ───────────────────────────────────────────────────────

describe("the group flag can no longer be set by a new booking", () => {
  // rate_defaults survives TRUNCATE, so the weight room group default is
  // saved and put back around every test here (the same way
  // session-actions.test.ts does it).
  async function setWeightRoomGroupDefault(cents: number | null) {
    await db
      .update(rateDefaults)
      .set({ groupRatePer30MinCents: cents })
      .where(eq(rateDefaults.type, "weight_room"));
  }
  async function getWeightRoomGroupDefault(): Promise<number | null> {
    const [row] = await db
      .select()
      .from(rateDefaults)
      .where(eq(rateDefaults.type, "weight_room"));
    return row?.groupRatePer30MinCents ?? null;
  }

  let savedGroupDefault: number | null = null;
  beforeEach(async () => {
    savedGroupDefault = await getWeightRoomGroupDefault();
    await setWeightRoomGroupDefault(null);
  });
  afterEach(async () => {
    await setWeightRoomGroupDefault(savedGroupDefault);
  });

  // Give the wrong answer everything it needs: a facility group rate AND a
  // coach group rate, both different from the coach's regular rate. If the
  // flag were honored the row would carry 1800 (or 1500); it must carry 950.
  async function configureGroupRates() {
    await setWeightRoomGroupDefault(1500);
    await db.insert(coachRateOverrides).values({
      coachId: fixtures.coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 950,
      groupRatePer30MinCents: 1800,
    });
  }

  it("createSessionInternal: isGroupSession true is stored false, at the REGULAR rate", async () => {
    await configureGroupRates();

    const created = await createSessionInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      resourceId: seeded.weightRoom1.id,
      startAt: at(FUTURE_DAY, "15:00"),
      endAt: at(FUTURE_DAY, "16:00"),
      isGroupSession: true,
    });

    expect(created.isGroupSession).toBe(false);
    expect(created.ratePer30MinCents).toBe(950);
  });

  it("createSessionsBatchInternal: isGroupSession true is stored false, at the REGULAR rate, on the merged row", async () => {
    await configureGroupRates();

    const inserted = await createSessionsBatchInternal(fixtures.admin, {
      coachId: fixtures.coach.id,
      isGroupSession: true,
      slots: [
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
        {
          resourceId: seeded.weightRoom1.id,
          startAt: at(FUTURE_DAY, "15:30"),
          endAt: at(FUTURE_DAY, "16:00"),
        },
        {
          resourceId: seeded.cage1.id,
          startAt: at(FUTURE_DAY, "15:00"),
          endAt: at(FUTURE_DAY, "15:30"),
        },
      ],
    });

    // The flag and the rate first, on every row, so this test speaks to the
    // group flag whatever the row count is.
    expect(inserted.map((r) => r.isGroupSession)).toEqual(
      inserted.map(() => false),
    );
    const wrRows = inserted.filter(
      (r) => r.resourceId === seeded.weightRoom1.id,
    );
    expect(wrRows.length).toBeGreaterThan(0);
    expect(wrRows.map((r) => r.ratePer30MinCents)).toEqual(
      wrRows.map(() => 950),
    );

    expect(inserted).toHaveLength(2);
    expect(wrRows).toHaveLength(1);
    expect(minutes(wrRows[0])).toBe(60);
    const cage = inserted.find((r) => r.resourceId === seeded.cage1.id)!;
    expect(cage.isGroupSession).toBe(false);
  });

  it("an OLD group rental keeps its flag and its rate when its time is edited", async () => {
    await configureGroupRates();
    // 1234 matches none of the configured rates, so it can only be the
    // stored one.
    const oldGroup = await seedRentalDirect({
      resourceId: seeded.weightRoom1.id,
      day: FUTURE_DAY,
      start: "15:00",
      end: "16:00",
      ratePer30MinCents: 1234,
      isGroupSession: true,
    });
    expect(oldGroup.isGroupSession).toBe(true);

    const updated = await updateSessionInternal(fixtures.admin, oldGroup.id, {
      endAt: at(FUTURE_DAY, "16:30"),
    });

    expect(updated.isGroupSession).toBe(true);
    expect(updated.ratePer30MinCents).toBe(1234);
    expect(minutes(updated)).toBe(90);
  });
});

// ── the historical import is exempt ──────────────────────────────────────

describe("executeCommitPlan (historical import) is exempt from the minimum", () => {
  // One tab, one day, one "Weight Room" row with a single half-hour cell
  // filled at 10:00. The parser reads the first "Weight Room" row of a day as
  // "Weight Room 1" and one filled cell as one 30-minute rental.
  async function workbookWithOneHalfHourWeightRoomCell(
    date: Date,
    rawName: string,
  ): Promise<ArrayBuffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Test Week");
    ws.getRow(4).getCell(4).value = date;
    ws.getRow(5).getCell(3).value = "8:00-8:30";
    const row = ws.getRow(6);
    row.getCell(1).value = "Weight Room";
    // Column 3 is 08:00 and each column is 30 minutes, so 10:00 is column 7.
    row.getCell(7).value = rawName;
    return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
  }

  it("a 30-minute weight room row still imports", async () => {
    const rawName = `Old Weight Room Import ${uniqueSuffix()}`;
    const buf = await workbookWithOneHalfHourWeightRoomCell(
      new Date(Date.UTC(2026, 4, 12)),
      rawName,
    );

    const result = await executeCommitPlan(fixtures.admin, buf, [
      { rawName, action: "map", mappedUserId: fixtures.coach.id },
    ]);

    expect(result.errored).toEqual([]);
    expect(result.skippedByPlan).toEqual([]);
    expect(result.skippedOverlaps).toBe(0);
    expect(result.skippedDuplicates).toBe(0);
    expect(result.created).toBe(1);

    let imported: Row[] = [];
    for (let attempt = 0; attempt < 8 && imported.length === 0; attempt++) {
      imported = await db
        .select()
        .from(sessionsBilling)
        .where(eq(sessionsBilling.source, "historical_import"));
      if (imported.length === 0) await sleep(250);
    }
    expect(imported).toHaveLength(1);
    expect(imported[0].resourceId).toBe(seeded.weightRoom1.id);
    expect(imported[0].coachId).toBe(fixtures.coach.id);
    expect(minutes(imported[0])).toBe(30);
    expect(imported[0].startAt.getTime()).toBe(
      parsePfaInput("2026-05-12", "10:00").getTime(),
    );
  });
});
