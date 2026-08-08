// Integration tests for the retroactive re-price engine (SPEC
// rate-effective-dating §6, Phase B). These hit a real Neon dev branch — see
// vitest.integration.config.ts and tests/integration/setup.ts for env wiring.
//
// We call the INTERNAL functions (src/lib/server/rate-reprice.ts) directly
// with a synthetic admin actor. There are no "use server" wrappers yet
// (Phase C), and the engine deliberately lives outside one.
//
// What only a real DB can prove, and therefore what these tests are for:
//   - the UPDATE lands on exactly the intended rows and the stamps read back
//     correctly, with `workPayForLog` returning the new pay;
//   - HELD and REJECTED rows are untouched by a live UPDATE;
//   - a coach holding an override is untouched by a program-default retro;
//   - a second apply writes NOTHING (idempotence) — checked down to
//     `updated_at`, which a no-op UPDATE would bump;
//   - PREVIEW leaves both hour_logs and audit_log byte-identical;
//   - the audit row carries every old per-log rate and pay.
//
// truncateMutables() does NOT touch `programs`, `program_rate_overrides` or
// `hour_logs`, so every test creates its own program with a unique name and
// tears its own rows down. audit_log IS truncated between tests.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  hourLogs,
  programRateOverrides,
  programs,
} from "@/db/schema";
import { buildAuditRowValues } from "@/lib/audit";
import { workPayForLog } from "@/lib/billing";
import {
  applyRateReprice,
  buildRepriceAuditInput,
  previewRateReprice,
} from "@/lib/server/rate-reprice";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// The engine's import chain reaches @/lib/authz → @/auth → next-auth, which
// does not resolve in the vitest node environment. We call internals with a
// synthetic actor, so stubbing @/auth only breaks that import chain.
vi.mock("@/auth", () => ({ auth: vi.fn() }));

let fixtures: FixtureUsers;
const createdProgramIds: string[] = [];

beforeAll(async () => {
  // HARD GUARD. This suite WRITES pay rates. It must never run against the
  // production branch (ep-purple-credit); the dev/integration branch is
  // ep-dawn-forest. setup.ts already swaps DATABASE_URL →
  // INTEGRATION_DATABASE_URL, this asserts where that landed.
  const host = new URL(process.env.DATABASE_URL ?? "http://unset").host;
  if (!host.includes("dawn-forest")) {
    throw new Error(
      `Refusing to run the re-price suite against "${host}". ` +
        "Expected the dev branch (ep-dawn-forest) via INTEGRATION_DATABASE_URL.",
    );
  }
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
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
  const name = `Reprice Test Program ${uniqueSuffix()}`;
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
// gate. That gate is exhaustively covered elsewhere; here we need precise
// control over the historical STAMPS (which is exactly what a pre-rate log
// looks like: null rate, null provenance) and over `status`.
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

async function readLogsForProgram(programId: string) {
  return db
    .select()
    .from(hourLogs)
    .where(eq(hourLogs.programId, programId))
    .orderBy(hourLogs.startAt);
}

// ─────────────────────────────────────────────────────────────────────────
describe("applyRateReprice — program-default retro", () => {
  it("re-prices posted logs, and leaves held / rejected / pre-date / override-coach rows alone", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 }); // $30/hr
    const effectiveFrom = daysAgo(10, 0);

    // The coach with NO override — the one the program default reaches.
    const postedA = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 120,
    });
    const postedB = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(3),
      minutes: 45,
    });
    // Guardrails: never touched.
    const heldLog = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      status: "held",
    });
    const rejectedLog = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(2),
      status: "rejected",
    });
    const beforeDateLog = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(20),
    });

    // SPEC §5: a coach holding their own override on this program.
    await db.insert(programRateOverrides).values({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 2000,
    });
    const overrideCoachLog = await seedLog({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
      ratePer30MinCents: 900, // deliberately stale — the retro must NOT fix it
      rateSourceKind: "program_default",
    });

    const result = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });

    expect(result.appliedLogCount).toBe(2);
    expect(result.appliedGroupCount).toBe(1);
    expect(result.preview.totalDeltaCents).toBe(6000 + 2250);
    expect(result.preview.increases.logCount).toBe(2);
    expect(result.preview.decreases.logCount).toBe(0);

    // §5 exclusion, reported by name.
    expect(result.preview.excludedCoaches).toEqual([
      {
        coachId: fixtures.flaggedCoach.id,
        coachName: fixtures.flaggedCoach.name,
        logCount: 1,
        reason: "resolves_from_own_override",
      },
    ]);

    // Stamps + the money the read path will now report.
    const a = await readLog(postedA);
    expect(a.ratePer30MinCents).toBe(1500);
    expect(a.perSessionRateCents).toBeNull();
    expect(a.rateSourceKind).toBe("program_default");
    expect(workPayForLog(a)).toBe(6000); // 2h × $30

    const b = await readLog(postedB);
    expect(b.ratePer30MinCents).toBe(1500);
    expect(workPayForLog(b)).toBe(2250); // 45min × $30/hr

    // Untouched rows.
    for (const id of [heldLog, rejectedLog, beforeDateLog]) {
      const row = await readLog(id);
      expect(row.ratePer30MinCents).toBeNull();
      expect(row.perSessionRateCents).toBeNull();
      expect(row.rateSourceKind).toBeNull();
      expect(workPayForLog(row)).toBe(0);
    }

    // The override coach keeps her stale stamp: the program retro cannot
    // reach her, whatever date is picked (SPEC §5).
    const o = await readLog(overrideCoachLog);
    expect(o.ratePer30MinCents).toBe(900);
    expect(o.rateSourceKind).toBe("program_default");

    // Audit: one row per (coach, program) group, carrying the old values.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "hour_log_reprice"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe(`${fixtures.coach.id}::${program.id}`);
    expect(audits[0].actorUserId).toBe(fixtures.admin.id);
    expect(audits[0].action).toBe("update");
    const diff = audits[0].diff as {
      before: { logs: { id: string; ratePer30MinCents: number | null; payCents: number }[] };
      after: { logs: { id: string; ratePer30MinCents: number | null; payCents: number }[] };
    };
    expect(diff.before.logs).toHaveLength(2);
    // Enough to reconstruct the prior state.
    expect(diff.before.logs.every((l) => l.ratePer30MinCents === null)).toBe(true);
    expect(diff.before.logs.every((l) => l.payCents === 0)).toBe(true);
    expect(diff.after.logs.map((l) => l.payCents).sort((x, y) => x - y)).toEqual([
      2250, 6000,
    ]);
    expect(diff.before.logs.map((l) => l.id).sort()).toEqual(
      [postedA, postedB].sort(),
    );
  });

  it("is idempotent — a second apply writes nothing at all", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1200 });
    const effectiveFrom = daysAgo(10, 0);
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 90,
    });

    const first = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(first.appliedLogCount).toBe(1);

    const afterFirst = await readLogsForProgram(program.id);

    const second = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(second.appliedLogCount).toBe(0);
    expect(second.appliedGroupCount).toBe(0);
    expect(second.auditEntityIds).toEqual([]);
    expect(second.preview.changedLogCount).toBe(0);
    expect(second.preview.unchangedLogCount).toBe(1);

    // Byte-identical, updated_at included — a no-op UPDATE would have bumped
    // it via the $onUpdate hook, so this is what proves nothing was written.
    const afterSecond = await readLogsForProgram(program.id);
    expect(afterSecond).toEqual(afterFirst);

    // And no second audit row claiming a change that didn't happen.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "hour_log_reprice"));
    expect(audits).toHaveLength(1);
  });

  it("books a rate cut as a DECREASE and names who loses what", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(6),
      minutes: 60,
      ratePer30MinCents: 2000,
      rateSourceKind: "program_default",
    });

    const result = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });

    expect(result.preview.decreases.logCount).toBe(1);
    expect(result.preview.decreases.totalDeltaCents).toBe(-2000);
    expect(result.preview.decreases.byCoach).toEqual([
      {
        coachId: fixtures.coach.id,
        coachName: fixtures.coach.name,
        logCount: 1,
        oldPayCents: 4000,
        newPayCents: 2000,
        deltaCents: -2000,
      },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("the audit row is ATOMIC with the money", () => {
  it("rolls the pay rewrite BACK when the audit insert fails", async () => {
    // THE assertion that matters. The audit insert rides in the same
    // db.batch() as the UPDATEs — one Neon transaction — so a failing audit
    // row must take the money with it. Forced here the way it would really
    // break: audit_log.actor_user_id is an FK to users.id, so an actor who
    // does not exist makes the INSERT fail, and only the INSERT.
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const effectiveFrom = daysAgo(10, 0);
    const logId = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 120,
    });

    const before = await readLogsForProgram(program.id);
    expect(before[0].ratePer30MinCents).toBeNull();

    const ghostActor = {
      ...fixtures.admin,
      id: "no-such-user-00000000-0000-0000-0000-000000000000",
    };

    await expect(
      applyRateReprice(ghostActor, {
        scope: { kind: "program_default", programId: program.id },
        effectiveFrom,
      }),
    ).rejects.toThrow();

    // MONEY DID NOT MOVE. Full-row equality, updated_at included.
    const after = await readLogsForProgram(program.id);
    expect(after).toEqual(before);
    const row = await readLog(logId);
    expect(row.ratePer30MinCents).toBeNull();
    expect(row.perSessionRateCents).toBeNull();
    expect(row.rateSourceKind).toBeNull();
    expect(workPayForLog(row)).toBe(0);

    // ...and no partial audit row was left behind either.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "hour_log_reprice"));
    expect(audits).toHaveLength(0);

    // The same re-price still works with a real actor — the failure above
    // left nothing wedged.
    const ok = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(ok.appliedLogCount).toBe(1);
    expect((await readLog(logId)).ratePer30MinCents).toBe(1500);
  });

  it("persists exactly the row the shared audit builder produces", async () => {
    // End-to-end closure on the byte-identity the unit suite proves against
    // logAudit: what actually landed in audit_log is what buildAuditRowValues
    // returns for this group.
    const program = await createProgram({ defaultRatePer30MinCents: 2000 });
    const effectiveFrom = daysAgo(9, 0);
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
    });
    const scope = {
      kind: "program_default" as const,
      programId: program.id,
    };

    const applied = await applyRateReprice(fixtures.admin, {
      scope,
      effectiveFrom,
    });
    expect(applied.appliedGroupCount).toBe(1);

    const [stored] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "hour_log_reprice"));

    const expectedRow = buildAuditRowValues(
      buildRepriceAuditInput({
        actorId: fixtures.admin.id,
        scope,
        effectiveFrom,
        group: applied.preview.groups[0],
      }),
    );
    expect(stored.entityId).toBe(expectedRow.entityId);
    expect(stored.entityType).toBe(expectedRow.entityType);
    expect(stored.action).toBe(expectedRow.action);
    expect(stored.actorUserId).toBe(expectedRow.actorUserId);
    expect(stored.diff).toEqual(expectedRow.diff);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("applyRateReprice — per-session is stamped FLAT (migration 0052)", () => {
  it("pays the flat amount on a 3.5-hour log, and stays flat on re-apply", async () => {
    const program = await createProgram({
      payMode: "per_session",
      defaultPerSessionRateCents: 10_000, // $100 per game
    });
    const effectiveFrom = daysAgo(14, 0);

    const shortGame = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(6),
      minutes: 60,
    });
    const longGame = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 210, // 3.5 hours
    });

    const result = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(result.appliedLogCount).toBe(2);

    for (const id of [shortGame, longGame]) {
      const row = await readLog(id);
      // FLAT, not halved like the per-30-min field, and not scaled by hours.
      expect(row.perSessionRateCents).toBe(10_000);
      expect(row.ratePer30MinCents).toBeNull();
      expect(row.rateSourceKind).toBe("program_default");
      expect(workPayForLog(row)).toBe(10_000);
    }
    // The bug this guards: 3.5h × a faked hourly rate would have paid $350.
    expect(workPayForLog(await readLog(longGame))).toBe(
      workPayForLog(await readLog(shortGame)),
    );

    const second = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(second.appliedLogCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("applyRateReprice — override-scoped retro", () => {
  it("reaches the override coach and only her", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1500 });
    const effectiveFrom = daysAgo(10, 0);

    await db.insert(programRateOverrides).values({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      payMode: "hourly",
      ratePer30MinCents: 2500,
      effectiveFrom,
    });

    const hers = await seedLog({
      coachId: fixtures.flaggedCoach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
      ratePer30MinCents: 1500,
      rateSourceKind: "program_default",
    });
    const otherCoach = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 60,
    });

    const result = await applyRateReprice(fixtures.admin, {
      scope: {
        kind: "override",
        coachId: fixtures.flaggedCoach.id,
        programId: program.id,
      },
      effectiveFrom,
    });

    expect(result.appliedLogCount).toBe(1);
    const row = await readLog(hers);
    expect(row.ratePer30MinCents).toBe(2500);
    expect(row.rateSourceKind).toBe("override");
    expect(workPayForLog(row)).toBe(5000);

    // The other coach is not in scope for an override retro.
    const untouched = await readLog(otherCoach);
    expect(untouched.ratePer30MinCents).toBeNull();
    expect(untouched.rateSourceKind).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("previewRateReprice — zero writes against a live database", () => {
  it("leaves hour_logs and audit_log byte-identical", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1800 });
    const effectiveFrom = daysAgo(10, 0);
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
    });
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(4),
      minutes: 30,
      status: "held",
    });

    const logsBefore = await readLogsForProgram(program.id);
    const auditsBefore = await db.select().from(auditLog);

    const preview = await previewRateReprice({
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });

    // It computed a real, non-trivial diff...
    expect(preview.changedLogCount).toBe(1);
    expect(preview.totalDeltaCents).toBe(3600);
    expect(preview.groups).toHaveLength(1);

    // ...and changed nothing. Full-row equality, updated_at included.
    expect(await readLogsForProgram(program.id)).toEqual(logsBefore);
    expect(await db.select().from(auditLog)).toEqual(auditsBefore);

    // Applying afterwards still produces the same numbers — the preview did
    // not consume or half-apply anything.
    const applied = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(applied.appliedLogCount).toBe(preview.changedLogCount);
    expect(applied.preview.totalDeltaCents).toBe(preview.totalDeltaCents);
  });

  // ── SPEC §7 / Phase D1 — the SAME proof, with a CANDIDATE rate. ──
  // Extended rather than replaced: the full-row snapshot (updated_at
  // included) and the audit_log snapshot are the identical assertions, run
  // against the new input.

  it("prices a CANDIDATE rate and STILL leaves hour_logs and audit_log byte-identical", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1800 });
    const effectiveFrom = daysAgo(10, 0);
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
    });
    const scope = { kind: "program_default" as const, programId: program.id };

    const logsBefore = await readLogsForProgram(program.id);
    const auditsBefore = await db.select().from(auditLog);

    const persisted = await previewRateReprice({ scope, effectiveFrom });
    const candidate = await previewRateReprice({
      scope,
      effectiveFrom,
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 3000, // $60/hr typed, NOT saved
      },
    });

    // The candidate diff is the one the dialog must quote, and it is NOT the
    // diff for the rate currently on the row.
    expect(persisted.totalDeltaCents).toBe(3600);
    expect(candidate.totalDeltaCents).toBe(6000);
    expect(candidate.logs[0].newRatePer30MinCents).toBe(3000);
    expect(candidate.candidateRate).not.toBeNull();

    // ...and neither call changed anything. Full-row equality, updated_at
    // included — a write of any kind would bump it via the $onUpdate hook.
    expect(await readLogsForProgram(program.id)).toEqual(logsBefore);
    expect(await db.select().from(auditLog)).toEqual(auditsBefore);

    // The program row itself is untouched too: a candidate is not a save.
    const [programRow] = await db
      .select()
      .from(programs)
      .where(eq(programs.id, program.id));
    expect(programRow.defaultRatePer30MinCents).toBe(1800);

    // And applying (with no candidate, as always) uses the PERSISTED rate.
    const applied = await applyRateReprice(fixtures.admin, {
      scope,
      effectiveFrom,
    });
    expect(applied.preview.totalDeltaCents).toBe(persisted.totalDeltaCents);
    expect(applied.preview.candidateRate).toBeNull();
  });

  it("previews a candidate override for a coach who has NO override row yet", async () => {
    // The first-time case the inline preview exists for. Without a candidate
    // this same call throws ProgramRateOverrideNotFoundError (asserted in
    // "scope validation" below).
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 210, // 3.5 hours — the 0052 duration that exposed the bug
      ratePer30MinCents: 1000,
      rateSourceKind: "program_default",
    });
    const scope = {
      kind: "override" as const,
      coachId: fixtures.coach.id,
      programId: program.id,
    };

    const logsBefore = await readLogsForProgram(program.id);
    const auditsBefore = await db.select().from(auditLog);

    const preview = await previewRateReprice({
      scope,
      effectiveFrom,
      candidateRate: {
        kind: "override",
        payMode: "per_session",
        perSessionRateCents: 10_000, // $100 flat per game
      },
    });

    expect(preview.changedLogCount).toBe(1);
    // FLAT: $100, not 3.5h × anything (migration 0052's bug class).
    expect(preview.logs[0].newPerSessionRateCents).toBe(10_000);
    expect(preview.logs[0].newPayCents).toBe(10_000);
    expect(preview.logs[0].oldPayCents).toBe(7000); // 3.5h × $20/hr
    expect(preview.logs[0].newRateSourceKind).toBe("override");

    // Still nothing written — no override row conjured, no log touched.
    expect(await readLogsForProgram(program.id)).toEqual(logsBefore);
    expect(await db.select().from(auditLog)).toEqual(auditsBefore);
    const overrideRows = await db
      .select()
      .from(programRateOverrides)
      .where(eq(programRateOverrides.programId, program.id));
    expect(overrideRows).toHaveLength(0);
  });

  it("SPEC §5 survives a candidate: a program candidate cannot reach an override coach", async () => {
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
      startAt: daysAgo(5),
      minutes: 60,
      ratePer30MinCents: 900, // stale on purpose
      rateSourceKind: "program_default",
    });
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
    });

    const logsBefore = await readLogsForProgram(program.id);

    const preview = await previewRateReprice({
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 9_900, // absurd, on purpose
      },
    });

    // The default-paid coach moves to the CANDIDATE rate...
    expect(preview.logs.map((l) => l.coachId)).toEqual([fixtures.coach.id]);
    expect(preview.logs[0].newRatePer30MinCents).toBe(9_900);
    // ...and the override coach is still unreachable, still named.
    expect(preview.excludedCoaches).toEqual([
      {
        coachId: fixtures.flaggedCoach.id,
        coachName: fixtures.flaggedCoach.name,
        logCount: 1,
        reason: "resolves_from_own_override",
      },
    ]);
    expect(
      preview.logs.some((l) => l.logId === overrideCoachLog),
    ).toBe(false);

    // Write-free, as ever.
    expect(await readLogsForProgram(program.id)).toEqual(logsBefore);
  });

  it("🔒 applyRateReprice REFUSES a candidate rate and writes nothing", async () => {
    // SPEC §6 — the write may only ever re-resolve persisted state. The type
    // system forbids this call (RateRepriceApplyInput.candidateRate?: never);
    // this proves the runtime layer behind it, since a "use server" boundary
    // erases types. It REFUSES rather than silently ignores: dropping the
    // candidate would mean writing a number other than the one previewed.
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);
    await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
    });

    const before = await readLogsForProgram(program.id);

    await expect(
      applyRateReprice(fixtures.admin, {
        scope: { kind: "program_default", programId: program.id },
        effectiveFrom,
        candidateRate: {
          kind: "program_default",
          payMode: "hourly",
          defaultRatePer30MinCents: 9_900,
        },
      } as unknown as Parameters<typeof applyRateReprice>[1]),
    ).rejects.toThrow(/does not accept a candidate rate/);

    // Nothing written — full-row equality, updated_at included.
    expect(await readLogsForProgram(program.id)).toEqual(before);
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "hour_log_reprice"));
    expect(audits).toHaveLength(0);

    // The legitimate call still works and uses the PERSISTED rate ($20/hr),
    // never the 9_900 that was refused.
    const ok = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(ok.appliedLogCount).toBe(1);
    expect((await readLogsForProgram(program.id))[0].ratePer30MinCents).toBe(
      1000,
    );
  });

  it("does not trust a caller — apply recomputes from the database", async () => {
    // A hostile/stale client cannot hand `apply` a doctored diff: it takes
    // only (scope, effectiveFrom) and re-loads everything itself. Proven by
    // moving the rate BETWEEN preview and apply and watching apply use the
    // new one.
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const effectiveFrom = daysAgo(10, 0);
    const logId = await seedLog({
      coachId: fixtures.coach.id,
      programId: program.id,
      startAt: daysAgo(5),
      minutes: 60,
    });

    const stale = await previewRateReprice({
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(stale.logs[0].newPayCents).toBe(2000);

    await db
      .update(programs)
      .set({ defaultRatePer30MinCents: 3000 })
      .where(eq(programs.id, program.id));

    const applied = await applyRateReprice(fixtures.admin, {
      scope: { kind: "program_default", programId: program.id },
      effectiveFrom,
    });
    expect(applied.preview.logs[0].newPayCents).toBe(6000);
    const row = await readLog(logId);
    expect(row.ratePer30MinCents).toBe(3000);
    expect(workPayForLog(row)).toBe(6000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("scope validation", () => {
  it("refuses an override retro when no override row exists", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    await expect(
      previewRateReprice({
        scope: {
          kind: "override",
          coachId: fixtures.coach.id,
          programId: program.id,
        },
        effectiveFrom: daysAgo(5),
      }),
    ).rejects.toThrow(/No override exists/i);
  });

  it("refuses a future effective date", async () => {
    const program = await createProgram({ defaultRatePer30MinCents: 1000 });
    const tomorrow = new Date(Date.now() + 86_400_000);
    await expect(
      applyRateReprice(fixtures.admin, {
        scope: { kind: "program_default", programId: program.id },
        effectiveFrom: tomorrow,
      }),
    ).rejects.toThrow(/future/i);
    // and nothing was written
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "hour_log_reprice")));
    expect(audits).toHaveLength(0);
  });
});
