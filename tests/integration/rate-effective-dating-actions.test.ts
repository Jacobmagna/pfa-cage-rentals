// Integration tests for the Phase-C SERVER-ACTION layer of SPEC
// rate-effective-dating — the join between "set a rate" and "re-price what
// was already logged".
//
// Phase B's own suite (rate-reprice.test.ts) proves the ENGINE. This file
// proves the things that only exist once the engine is wired to a save:
//
//   1. no effective date  → byte-identical to the pre-feature behavior:
//      the rate is upserted, and NOT ONE already-logged row is touched;
//   2. a past effective date → exactly the in-window posted logs move;
//   3. 🔴 a DECREASE with no confirmDecrease is REFUSED and writes NOTHING
//      to hour_logs — asserted on the rows, not on the thrown error;
//   4. the same decrease WITH confirmDecrease: true applies;
//   5. every new public action rejects a non-admin;
//   6. a FUTURE effective date is rejected by the schema, before any write;
//   7. SPEC §5 survives the action layer: a program-default save cannot
//      reach a coach who holds their own override.
//
// The happy paths call the INTERNAL functions with a synthetic admin actor —
// the same split the rest of this suite uses, since the internals are where
// the logic lives and the public wrappers are authz + revalidation only. The
// wrappers are exercised in the authz test, which is the behavior they own.
//
// truncateMutables() does NOT touch `programs`, `program_rate_overrides` or
// `hour_logs`, so every test creates its own program with a unique name and
// tears its own rows down. audit_log IS truncated between tests.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programRateOverrides,
  programs,
} from "@/db/schema";
import { workPayForLog } from "@/lib/billing";
import { RateRepriceDecreaseNotConfirmedError } from "@/lib/errors";
import {
  updateProgramWithRepriceInternal,
  upsertProgramRateOverrideWithRepriceInternal,
} from "@/lib/server/rate-effective-dating-actions";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// The action layer's import chain reaches @/lib/authz → @/auth → next-auth,
// which does not resolve in the vitest node environment. A controllable mock
// (rather than a bare vi.fn) lets the authz block below drive requireRole
// with whatever session shape it needs; the internals never call auth().
const authMock = vi.fn();
vi.mock("@/auth", () => ({ auth: () => authMock() }));

let fixtures: FixtureUsers;
const createdProgramIds: string[] = [];

beforeAll(async () => {
  // HARD GUARD. This suite WRITES pay rates. It must never run against the
  // production branch (ep-purple-credit); the dev/integration branch is
  // ep-dawn-forest. setup.ts already swaps DATABASE_URL →
  // INTEGRATION_DATABASE_URL; this asserts where that landed.
  const host = new URL(process.env.DATABASE_URL ?? "http://unset").host;
  if (!host.includes("dawn-forest")) {
    throw new Error(
      `Refusing to run the rate-effective-dating action suite against "${host}". ` +
        "Expected the dev branch (ep-dawn-forest) via INTEGRATION_DATABASE_URL.",
    );
  }
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
  authMock.mockReset();
});

afterEach(async () => {
  if (createdProgramIds.length > 0) {
    // hour_logs → programs has NO cascade (programs are soft-deleted in the
    // app), so the logs come out first. program_rate_overrides DOES cascade.
    await db
      .delete(hourLogs)
      .where(inArray(hourLogs.programId, createdProgramIds));
    await db
      .delete(programRateOverrides)
      .where(inArray(programRateOverrides.programId, createdProgramIds));
    await db.delete(programs).where(inArray(programs.id, createdProgramIds));
    createdProgramIds.length = 0;
  }
});

// ─────────────────────────────────────────────────────────────────────────
// helpers (mirrors rate-reprice.test.ts)
// ─────────────────────────────────────────────────────────────────────────

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** N days before now, at a fixed UTC hour. Always in the past. */
function daysAgo(days: number, hour = 17): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

async function createProgram(values: {
  payMode?: "hourly" | "per_session";
  defaultRatePer30MinCents?: number | null;
  defaultPerSessionRateCents?: number | null;
}): Promise<{ id: string; name: string }> {
  const name = `Effective Dating Action Test ${uniqueSuffix()}`;
  const [row] = await db
    .insert(programs)
    .values({
      name,
      active: true,
      payMode: values.payMode ?? "hourly",
      defaultRatePer30MinCents: values.defaultRatePer30MinCents ?? null,
      defaultPerSessionRateCents: values.defaultPerSessionRateCents ?? null,
    })
    .returning({ id: programs.id, name: programs.name });
  createdProgramIds.push(row.id);
  return row;
}

// Inserts an hour_log DIRECTLY, bypassing logHourInternal's held-then-approve
// gate — we need precise control over the historical STAMPS (a pre-rate log
// is exactly this: null rate, null provenance) and over `status`.
async function seedLog(values: {
  coachId: string;
  programId: string;
  startAt: Date;
  minutes?: number;
  ratePer30MinCents?: number | null;
  perSessionRateCents?: number | null;
  rateSourceKind?: "override" | "program_default" | "none" | null;
  status?: "posted" | "held" | "rejected";
}): Promise<string> {
  const startAt = values.startAt;
  const endAt = new Date(startAt.getTime() + (values.minutes ?? 60) * 60_000);
  const [row] = await db
    .insert(hourLogs)
    .values({
      coachId: values.coachId,
      programId: values.programId,
      startAt,
      endAt,
      ratePer30MinCents: values.ratePer30MinCents ?? null,
      perSessionRateCents: values.perSessionRateCents ?? null,
      rateSourceKind: values.rateSourceKind ?? null,
      status: values.status ?? "posted",
      heldReason: values.status === "held" ? "unscheduled" : null,
      createdBy: values.coachId,
    })
    .returning({ id: hourLogs.id });
  return row.id;
}

async function readLog(id: string) {
  const [row] = await db.select().from(hourLogs).where(eq(hourLogs.id, id));
  return row;
}

async function readOverride(coachId: string, programId: string) {
  const rows = await db
    .select()
    .from(programRateOverrides)
    .where(eq(programRateOverrides.programId, programId));
  return rows.find((r) => r.coachId === coachId) ?? null;
}

async function repriceAuditRows() {
  return db
    .select()
    .from(auditLog)
    .where(eq(auditLog.entityType, "hour_log_reprice"));
}

// ─────────────────────────────────────────────────────────────────────────
// 1. NO effective date — today's behavior, byte for byte
// ─────────────────────────────────────────────────────────────────────────
describe("save with NO effective date", () => {
  it("upserts the override and leaves every already-logged row untouched", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: null });
    const stale = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 120,
    });
    const before = await readLog(stale);

    const result = await upsertProgramRateOverrideWithRepriceInternal(
      fixtures.admin,
      {
        coachId: fixtures.coach.id,
        programId: program.id,
        payMode: "hourly",
        ratePer30MinCents: 2000,
      },
    );

    // The engine was never called — not "called and found nothing".
    expect(result.reprice).toEqual({ status: "not_requested" });
    expect(result.override.ratePer30MinCents).toBe(2000);
    // Null effective date is stored as null: this rate is "going forward".
    expect(result.override.effectiveFrom).toBeNull();

    // The already-logged row is IDENTICAL — every column, updated_at included.
    expect(await readLog(stale)).toEqual(before);
    expect(workPayForLog(await readLog(stale))).toBe(0);

    // And no re-price ever touched the audit trail.
    expect(await repriceAuditRows()).toHaveLength(0);
  });

  it("updates the program default without re-pricing anything", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const stale = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
      ratePer30MinCents: 1000,
      rateSourceKind: "program_default",
    });
    const before = await readLog(stale);

    const result = await updateProgramWithRepriceInternal(
      fixtures.admin,
      program.id,
      { defaultRatePer30MinCents: 2500 },
    );

    expect(result.reprice).toEqual({ status: "not_requested" });
    expect(result.program.defaultRatePer30MinCents).toBe(2500);
    // Key-absent must not clobber the stored date (it was null here anyway).
    expect(result.program.defaultRateEffectiveFrom).toBeNull();

    expect(await readLog(stale)).toEqual(before);
    expect(workPayForLog(await readLog(stale))).toBe(2000);
    expect(await repriceAuditRows()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. A PAST effective date — exactly the in-window logs
// ─────────────────────────────────────────────────────────────────────────
describe("save WITH a past effective date", () => {
  it("re-prices exactly the in-window posted logs, and nothing else", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: null });
    const effectiveFrom = daysAgo(10, 0);

    const inWindow = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(3),
      minutes: 60,
    });
    const beforeWindow = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(20),
      minutes: 60,
    });
    const heldInWindow = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
      status: "held",
    });
    const rejectedInWindow = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(2),
      minutes: 60,
      status: "rejected",
    });

    const untouchedBefore = {
      beforeWindow: await readLog(beforeWindow),
      heldInWindow: await readLog(heldInWindow),
      rejectedInWindow: await readLog(rejectedInWindow),
    };

    const result = await upsertProgramRateOverrideWithRepriceInternal(
      fixtures.admin,
      {
        coachId: fixtures.coach.id,
        programId: program.id,
        payMode: "hourly",
        ratePer30MinCents: 2000,
        effectiveFrom,
      },
    );

    expect(result.reprice.status).toBe("applied");
    if (result.reprice.status !== "applied") throw new Error("unreachable");
    expect(result.reprice.appliedLogCount).toBe(1);
    expect(result.reprice.appliedGroupCount).toBe(1);
    expect(result.reprice.preview.decreases.logCount).toBe(0);
    expect(result.reprice.preview.increases.totalDeltaCents).toBe(4000);

    // The effective date is persisted on the rate row (SPEC §7 history).
    expect(result.override.effectiveFrom?.getTime()).toBe(
      effectiveFrom.getTime(),
    );

    const moved = await readLog(inWindow);
    expect(moved.ratePer30MinCents).toBe(2000);
    expect(moved.perSessionRateCents).toBeNull();
    expect(moved.rateSourceKind).toBe("override");
    expect(workPayForLog(moved)).toBe(4000); // 1h × $40/hr

    expect(await readLog(beforeWindow)).toEqual(untouchedBefore.beforeWindow);
    expect(await readLog(heldInWindow)).toEqual(untouchedBefore.heldInWindow);
    expect(await readLog(rejectedInWindow)).toEqual(
      untouchedBefore.rejectedInWindow,
    );

    // One audit row for the one (coach, program) group.
    expect(await repriceAuditRows()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3 + 4. 🔴 THE DECREASE GUARD
// ─────────────────────────────────────────────────────────────────────────
describe("the server-side decrease guard (SPEC §6)", () => {
  async function seedDecreaseScenario() {
    const program = await createProgram({ defaultRatePer30MinCents: null });
    await db.insert(programRateOverrides).values({
      coachId: fixtures.coach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 2000,
    });
    const logId = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(3),
      minutes: 120,
      ratePer30MinCents: 2000,
      rateSourceKind: "override",
    });
    return { program, logId, effectiveFrom: daysAgo(10, 0) };
  }

  it("REFUSES a decrease without confirmDecrease, and writes NOTHING to hour_logs", async () => {
    const { program, logId, effectiveFrom } = await seedDecreaseScenario();
    const before = await readLog(logId);
    expect(workPayForLog(before)).toBe(8000); // 2h × $40/hr

    let thrown: unknown;
    try {
      await upsertProgramRateOverrideWithRepriceInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        programId: program.id,
        payMode: "hourly",
        ratePer30MinCents: 1000,
        effectiveFrom,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RateRepriceDecreaseNotConfirmedError);
    const refusal = thrown as RateRepriceDecreaseNotConfirmedError;
    expect(refusal.code).toBe("RATE_REPRICE_DECREASE_NOT_CONFIRMED");
    // The refusal carries the diff the SERVER computed — who loses what.
    expect(refusal.preview.decreases.logCount).toBe(1);
    expect(refusal.preview.decreases.totalDeltaCents).toBe(-4000);
    expect(refusal.preview.decreases.byCoach).toEqual([
      {
        coachId: fixtures.coach.id,
        coachName: fixtures.coach.name,
        logCount: 1,
        oldPayCents: 8000,
        newPayCents: 4000,
        deltaCents: -4000,
      },
    ]);

    // ── THE POINT OF THIS TEST ──
    // Not "it returned an error" — the ROW is byte-identical, every column,
    // updated_at included, and the money the read path reports is unchanged.
    expect(await readLog(logId)).toEqual(before);
    expect(workPayForLog(await readLog(logId))).toBe(8000);
    // And nothing was written to the re-price audit trail either.
    expect(await repriceAuditRows()).toHaveLength(0);

    // DOCUMENTED CONSEQUENCE of "upsert the rate first, then re-price": the
    // rate itself IS saved (going forward), because the engine re-resolves
    // from that row and cannot be asked "what if". The refusal blocks the
    // RETRO half only, which is the half that moves money already handed
    // over. Pinned by a test so it can never become an accident.
    const override = await readOverride(fixtures.coach.id, program.id);
    expect(override?.ratePer30MinCents).toBe(1000);
  });

  it("APPLIES the same decrease when confirmDecrease is true", async () => {
    const { program, logId, effectiveFrom } = await seedDecreaseScenario();

    const result = await upsertProgramRateOverrideWithRepriceInternal(
      fixtures.admin,
      {
        coachId: fixtures.coach.id,
        programId: program.id,
        payMode: "hourly",
        ratePer30MinCents: 1000,
        effectiveFrom,
        confirmDecrease: true,
      },
    );

    expect(result.reprice.status).toBe("applied");
    if (result.reprice.status !== "applied") throw new Error("unreachable");
    expect(result.reprice.appliedLogCount).toBe(1);
    expect(result.reprice.preview.totalDeltaCents).toBe(-4000);

    const after = await readLog(logId);
    expect(after.ratePer30MinCents).toBe(1000);
    expect(after.rateSourceKind).toBe("override");
    expect(workPayForLog(after)).toBe(4000); // 2h × $20/hr

    // The reversibility record: the audit row carries the OLD per-log pay.
    const audit = await repriceAuditRows();
    expect(audit).toHaveLength(1);
    const diff = audit[0].diff as {
      before: { totalPayCents: number; logs: { payCents: number }[] };
      after: { totalPayCents: number };
    };
    expect(diff.before.totalPayCents).toBe(8000);
    expect(diff.before.logs).toEqual([
      expect.objectContaining({ ratePer30MinCents: 2000, payCents: 8000 }),
    ]);
    expect(diff.after.totalPayCents).toBe(4000);
  });

  it("refuses a program-default decrease too, leaving hour_logs untouched", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 2000 });
    const logId = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(3),
      minutes: 60,
      ratePer30MinCents: 2000,
      rateSourceKind: "program_default",
    });
    const before = await readLog(logId);

    await expect(
      updateProgramWithRepriceInternal(fixtures.admin, program.id, {
        defaultRatePer30MinCents: 500,
        defaultRateEffectiveFrom: daysAgo(10, 0),
      }),
    ).rejects.toBeInstanceOf(RateRepriceDecreaseNotConfirmedError);

    expect(await readLog(logId)).toEqual(before);
    expect(await repriceAuditRows()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. AUTHZ — every new public action rejects a non-admin
// ─────────────────────────────────────────────────────────────────────────
describe("authz on the public wrappers", () => {
  // requireRole("admin") calls redirect(), which throws NEXT_REDIRECT. We
  // only care that the action never got far enough to touch the database.
  const nonAdminSessions = () => [
    {
      label: "a coach",
      session: {
        user: {
          id: fixtures.coach.id,
          email: fixtures.coach.email,
          role: "coach",
        },
      },
    },
    {
      label: "a schedule-admin coach",
      session: {
        user: {
          id: fixtures.flaggedCoach.id,
          email: fixtures.flaggedCoach.email,
          role: "coach",
          scheduleAdmin: true,
        },
      },
    },
    { label: "a signed-out visitor", session: null },
  ];

  it("rejects non-admins on all four new actions", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    // Dynamic import AFTER vi.mock is registered so the wrappers resolve the
    // mocked `@/auth`.
    const coachActions = await import("@/app/admin/coaches/[id]/actions");
    const programActions = await import(
      "@/app/admin/hour-log/programs/actions"
    );

    const scope = { kind: "program_default" as const, programId: program.id };
    const effectiveFrom = daysAgo(10, 0);

    for (const { session } of nonAdminSessions()) {
      authMock.mockResolvedValue(session);

      await expect(
        coachActions.previewProgramRateOverrideReprice({
          scope: {
            kind: "override",
            coachId: fixtures.coach.id,
            programId: program.id,
          },
          effectiveFrom,
        }),
      ).rejects.toThrow();

      await expect(
        coachActions.upsertProgramRateOverrideWithReprice({
          coachId: fixtures.coach.id,
          programId: program.id,
          payMode: "hourly",
          ratePer30MinCents: 9999,
          effectiveFrom,
        }),
      ).rejects.toThrow();

      await expect(
        programActions.previewProgramDefaultRateReprice({
          scope,
          effectiveFrom,
        }),
      ).rejects.toThrow();

      await expect(
        programActions.updateProgramWithReprice(program.id, {
          defaultRatePer30MinCents: 9999,
          defaultRateEffectiveFrom: effectiveFrom,
        }),
      ).rejects.toThrow();
    }

    // Nothing got through: no override row was created, and the program's
    // default rate is exactly what it was seeded with.
    expect(await readOverride(fixtures.coach.id, program.id)).toBeNull();
    const [row] = await db
      .select()
      .from(programs)
      .where(eq(programs.id, program.id));
    expect(row.defaultRatePer30MinCents).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. FUTURE dates — rejected by the schema, before any write
// ─────────────────────────────────────────────────────────────────────────
describe("future effective dates (SPEC §3 / decision §10.1)", () => {
  const tomorrow = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

  it("rejects a future effectiveFrom on an override, writing nothing", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });

    await expect(
      upsertProgramRateOverrideWithRepriceInternal(fixtures.admin, {
        coachId: fixtures.coach.id,
        programId: program.id,
        payMode: "hourly",
        ratePer30MinCents: 2000,
        effectiveFrom: tomorrow(),
      }),
    ).rejects.toThrow(/future/i);

    // The parse happens BEFORE the upsert, so no override row exists.
    expect(await readOverride(fixtures.coach.id, program.id)).toBeNull();
  });

  it("rejects a future defaultRateEffectiveFrom on a program, writing nothing", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });

    await expect(
      updateProgramWithRepriceInternal(fixtures.admin, program.id, {
        defaultRatePer30MinCents: 2000,
        defaultRateEffectiveFrom: tomorrow(),
      }),
    ).rejects.toThrow(/future/i);

    const [row] = await db
      .select()
      .from(programs)
      .where(eq(programs.id, program.id));
    expect(row.defaultRatePer30MinCents).toBe(1000);
    expect(row.defaultRateEffectiveFrom).toBeNull();
  });

  it("accepts an effective date of right now (present is not future)", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const result = await upsertProgramRateOverrideWithRepriceInternal(
      fixtures.admin,
      {
        coachId: fixtures.coach.id,
        programId: program.id,
        payMode: "hourly",
        ratePer30MinCents: 2000,
        effectiveFrom: new Date(),
      },
    );
    expect(result.reprice.status).toBe("applied");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. SPEC §5 survives the action layer
// ─────────────────────────────────────────────────────────────────────────
describe("SPEC §5 — a program-default save cannot reach an override coach", () => {
  it("re-prices the default-paid coach and reports the override coach by name", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const effectiveFrom = daysAgo(10, 0);

    // Coach with NO override — the one the program default reaches.
    const defaultPaid = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
    });

    // Coach WITH their own override on this program. Their log is stamped
    // deliberately stale — the program retro must NOT "fix" it.
    await db.insert(programRateOverrides).values({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 2000,
    });
    const overrideCoachLog = await seedLog({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
      ratePer30MinCents: 900,
      rateSourceKind: "program_default",
    });
    const overrideCoachBefore = await readLog(overrideCoachLog);

    const result = await updateProgramWithRepriceInternal(
      fixtures.admin,
      program.id,
      {
        defaultRatePer30MinCents: 3000,
        defaultRateEffectiveFrom: effectiveFrom,
      },
    );

    expect(result.program.defaultRateEffectiveFrom?.getTime()).toBe(
      effectiveFrom.getTime(),
    );
    expect(result.reprice.status).toBe("applied");
    if (result.reprice.status !== "applied") throw new Error("unreachable");
    expect(result.reprice.appliedLogCount).toBe(1);

    const moved = await readLog(defaultPaid);
    expect(moved.ratePer30MinCents).toBe(3000);
    expect(moved.rateSourceKind).toBe("program_default");
    expect(workPayForLog(moved)).toBe(6000);

    // The override coach's row is byte-identical — stale rate and all.
    expect(await readLog(overrideCoachLog)).toEqual(overrideCoachBefore);

    // …and is reported BY NAME so Phase D can show Mark the rule working.
    expect(result.reprice.preview.excludedCoaches).toEqual([
      {
        coachId: fixtures.flaggedCoach.id,
        coachName: fixtures.flaggedCoach.name,
        logCount: 1,
        reason: "resolves_from_own_override",
      },
    ]);

    // One audit row: the default-paid coach's group only.
    expect(await repriceAuditRows()).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. SPEC §7 / Phase D1 — the PUBLIC preview actions take a CANDIDATE rate
// ─────────────────────────────────────────────────────────────────────────
//
// Why this matters at the action layer: §7 puts the preview INLINE, before
// Save is armed, so the rate Mark typed is not persisted yet. Without a
// candidate the dialog would quote the number for the OLD rate and then write
// a different one. These prove the two public wrappers carry the candidate
// through, stay admin-gated, and stay read-only.
describe("candidate rate through the public preview actions (SPEC §7)", () => {
  async function adminActions() {
    authMock.mockResolvedValue({
      user: {
        id: fixtures.admin.id,
        email: fixtures.admin.email,
        role: "admin",
      },
    });
    return {
      coach: await import("@/app/admin/coaches/[id]/actions"),
      program: await import("@/app/admin/hour-log/programs/actions"),
    };
  }

  it("previewProgramDefaultRateReprice quotes the CANDIDATE rate, writes nothing", async () => {
    const actions = await adminActions();
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);
    const logId = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
    });
    const scope = { kind: "program_default" as const, programId: program.id };
    const before = await readLog(logId);

    const persisted = await actions.program.previewProgramDefaultRateReprice({
      scope,
      effectiveFrom,
    });
    const candidate = await actions.program.previewProgramDefaultRateReprice({
      scope,
      effectiveFrom,
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 3000,
      },
    });

    expect(persisted.totalDeltaCents).toBe(2000); // $20/hr, the saved rate
    expect(candidate.totalDeltaCents).toBe(6000); // $60/hr, the typed rate
    expect(candidate.logs[0].newRatePer30MinCents).toBe(3000);

    // Read-only: the log, the program row and the audit trail are untouched.
    expect(await readLog(logId)).toEqual(before);
    const [programRow] = await db
      .select()
      .from(programs)
      .where(eq(programs.id, program.id));
    expect(programRow.defaultRatePer30MinCents).toBe(1000);
    expect(await repriceAuditRows()).toHaveLength(0);
  });

  it("previewProgramRateOverrideReprice works before the override row exists", async () => {
    const actions = await adminActions();
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);
    const logId = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 120,
      ratePer30MinCents: 1000,
      rateSourceKind: "program_default",
    });
    const scope = {
      kind: "override" as const,
      coachId: fixtures.coach.id,
      programId: program.id,
    };
    const before = await readLog(logId);

    // Without a candidate there is no override to preview against.
    await expect(
      actions.coach.previewProgramRateOverrideReprice({ scope, effectiveFrom }),
    ).rejects.toThrow(/No override exists/i);

    const preview = await actions.coach.previewProgramRateOverrideReprice({
      scope,
      effectiveFrom,
      candidateRate: {
        kind: "override",
        payMode: "hourly",
        ratePer30MinCents: 2500,
      },
    });
    expect(preview.changedLogCount).toBe(1);
    expect(preview.logs[0].newRatePer30MinCents).toBe(2500);
    expect(preview.logs[0].oldPayCents).toBe(4000);
    expect(preview.logs[0].newPayCents).toBe(10_000);
    expect(preview.logs[0].newRateSourceKind).toBe("override");

    // Nothing written: no override row conjured, log byte-identical.
    expect(await readOverride(fixtures.coach.id, program.id)).toBeNull();
    expect(await readLog(logId)).toEqual(before);
    expect(await repriceAuditRows()).toHaveLength(0);
  });

  it("a candidate cannot make a program-default preview reach an override coach (§5)", async () => {
    const actions = await adminActions();
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);

    await db.insert(programRateOverrides).values({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 2000,
    });
    const overrideCoachLog = await seedLog({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
      ratePer30MinCents: 900,
      rateSourceKind: "program_default",
    });
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
    });
    const overrideCoachBefore = await readLog(overrideCoachLog);

    const preview = await actions.program.previewProgramDefaultRateReprice({
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 9_900,
      },
    });

    expect(preview.logs.map((l) => l.coachId)).toEqual([fixtures.coach.id]);
    expect(preview.excludedCoaches).toEqual([
      {
        coachId: fixtures.flaggedCoach.id,
        coachName: fixtures.flaggedCoach.name,
        logCount: 1,
        reason: "resolves_from_own_override",
      },
    ]);
    expect(await readLog(overrideCoachLog)).toEqual(overrideCoachBefore);
  });

  it("refuses a candidate that could never be saved, and a scope mismatch", async () => {
    const actions = await adminActions();
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const scope = { kind: "program_default" as const, programId: program.id };
    const effectiveFrom = daysAgo(10, 0);

    // per_session with no amount — the rule that stops a silent $0 preview.
    await expect(
      actions.program.previewProgramDefaultRateReprice({
        scope,
        effectiveFrom,
        candidateRate: { kind: "program_default", payMode: "per_session" },
      }),
    ).rejects.toThrow();

    // A fractional per-session amount.
    await expect(
      actions.program.previewProgramDefaultRateReprice({
        scope,
        effectiveFrom,
        candidateRate: {
          kind: "program_default",
          payMode: "per_session",
          defaultPerSessionRateCents: 99.5,
        },
      }),
    ).rejects.toThrow();

    // The same future-date cap as a real rate, candidate or not.
    await expect(
      actions.program.previewProgramDefaultRateReprice({
        scope,
        effectiveFrom: new Date(Date.now() + 86_400_000),
        candidateRate: {
          kind: "program_default",
          payMode: "hourly",
          defaultRatePer30MinCents: 2000,
        },
      }),
    ).rejects.toThrow(/future/i);

    // An override candidate smuggled into a program-default preview — the one
    // shape that could have dressed a §5-excluded coach up as reachable.
    await expect(
      actions.program.previewProgramDefaultRateReprice({
        scope,
        effectiveFrom,
        candidateRate: {
          kind: "override",
          payMode: "hourly",
          ratePer30MinCents: 5000,
        },
      }),
    ).rejects.toThrow(/cannot be previewed against a program_default/);

    expect(await repriceAuditRows()).toHaveLength(0);
  });

  it("stays admin-gated with a candidate supplied", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);
    const coachActions = await import("@/app/admin/coaches/[id]/actions");
    const programActions = await import(
      "@/app/admin/hour-log/programs/actions"
    );

    for (const session of [
      { user: { id: fixtures.coach.id, email: fixtures.coach.email, role: "coach" } },
      null,
    ]) {
      authMock.mockResolvedValue(session);
      await expect(
        programActions.previewProgramDefaultRateReprice({
          scope: { kind: "program_default", programId: program.id },
          effectiveFrom,
          candidateRate: {
            kind: "program_default",
            payMode: "hourly",
            defaultRatePer30MinCents: 9_900,
          },
        }),
      ).rejects.toThrow();
      await expect(
        coachActions.previewProgramRateOverrideReprice({
          scope: {
            kind: "override",
            coachId: fixtures.coach.id,
            programId: program.id,
          },
          effectiveFrom,
          candidateRate: {
            kind: "override",
            payMode: "hourly",
            ratePer30MinCents: 9_900,
          },
        }),
      ).rejects.toThrow();
    }
  });
});
