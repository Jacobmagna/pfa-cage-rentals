// Unit tests for the retroactive re-price engine (SPEC rate-effective-dating
// §6). Two things are under test here:
//
//   1. `computeRateRepriceDiff` — the PURE diff. It decides what money moves
//      on already-logged hours, so the (override × program × per-session)
//      matrix is exhaustive rather than illustrative.
//   2. `previewRateReprice` — proven WRITE-FREE against a db double whose
//      insert/update/delete/batch/execute/transaction all throw. If preview
//      ever grows a write, this test fails loudly instead of silently
//      re-pricing a live payroll during a "look, don't touch" preview.
//
// The invariants worth naming:
//   - §5 EXCLUSION IS STRUCTURAL. Override coaches are loaded, re-resolved,
//     and found to resolve from their own override — never filtered out of
//     the input. The tests feed them in and assert they come back named.
//   - PER-SESSION IS FLAT. Migration 0052's shipped bug class: a flat amount
//     must never be halved like the per-30-min field. Asserted across three
//     durations.
//   - IS DISTINCT FROM. A log already carrying the recomputed values is not
//     written at all — the property that makes a second apply a no-op.

import { beforeEach, describe, expect, it, vi } from "vitest";

// The engine module opens a DB client at import time (@/db throws without
// DATABASE_URL). The double below stands in for it: SELECT chains resolve
// from `rowsByTable`, and every mutating method throws. Hoisted so vi.mock
// can reference it.
const dbDouble = vi.hoisted(() => {
  const rowsByTable = new Map<unknown, unknown[]>();
  const writeAttempts: string[] = [];

  function forbid(name: string) {
    return (...args: unknown[]) => {
      void args;
      writeAttempts.push(name);
      throw new Error(`WRITE ATTEMPTED IN A READ-ONLY PATH: db.${name}()`);
    };
  }

  type Chain = {
    from: (t: unknown) => Chain;
    innerJoin: (...a: unknown[]) => Chain;
    leftJoin: (...a: unknown[]) => Chain;
    where: (...a: unknown[]) => Chain;
    limit: (...a: unknown[]) => Chain;
    orderBy: (...a: unknown[]) => Chain;
    then: (
      onFulfilled: (v: unknown[]) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise<unknown>;
  };

  function chain(table: unknown): Chain {
    const self: Chain = {
      from: (t: unknown) => chain(t),
      innerJoin: () => self,
      leftJoin: () => self,
      where: () => self,
      limit: () => self,
      orderBy: () => self,
      then: (onFulfilled, onRejected) =>
        Promise.resolve(rowsByTable.get(table) ?? []).then(
          onFulfilled,
          onRejected,
        ),
    };
    return self;
  }

  const db = {
    select: (..._args: unknown[]) => {
      void _args;
      return { from: (t: unknown) => chain(t) };
    },
    insert: forbid("insert"),
    update: forbid("update"),
    delete: forbid("delete"),
    batch: forbid("batch"),
    execute: forbid("execute"),
    transaction: forbid("transaction"),
  };

  return { db, rowsByTable, writeAttempts };
});

vi.mock("@/db", () => ({ db: dbDouble.db }));

import { hourLogs, programRateOverrides, programs } from "@/db/schema";
import { buildAuditRowValues, logAudit, type LogAuditInput } from "@/lib/audit";
import { workPayForLog } from "@/lib/billing";
import {
  ProgramNotFoundError,
  ProgramRateOverrideNotFoundError,
} from "@/lib/errors";
import {
  resolvePerSessionRateCents,
  resolveRateCentsForProgram,
  resolveRateSourceKind,
} from "./hour-log-actions";
import {
  applyRateReprice,
  buildRepriceAuditInput,
  computeRateRepriceDiff,
  previewRateReprice,
  type RateRepriceCandidate,
  type RateSourceKind,
  type RepriceLogRow,
} from "./rate-reprice";

// ── Fixtures ─────────────────────────────────────────────────────────────

const PROGRAM_ID = "program-1";
const EFFECTIVE_FROM = new Date("2026-06-19T00:00:00Z");

type ProgramFixture = Parameters<typeof computeRateRepriceDiff>[0]["program"];

function program(p: {
  payMode?: "hourly" | "per_session";
  hourly?: number | null;
  flat?: number | null;
  name?: string;
}): ProgramFixture {
  return {
    id: PROGRAM_ID,
    name: p.name ?? "Elite Hitting",
    payMode: p.payMode ?? "hourly",
    defaultRatePer30MinCents: p.hourly ?? null,
    defaultPerSessionRateCents: p.flat ?? null,
  };
}

type OverrideRow = typeof programRateOverrides.$inferSelect;

function override(o: {
  coachId: string;
  payMode: "hourly" | "per_session";
  hourly?: number | null;
  flat?: number | null;
  programId?: string;
}): OverrideRow {
  return {
    coachId: o.coachId,
    programId: o.programId ?? PROGRAM_ID,
    payMode: o.payMode,
    ratePer30MinCents: o.hourly ?? null,
    perSessionRateCents: o.flat ?? null,
    effectiveFrom: null,
    updatedAt: new Date("2026-08-07T00:00:00Z"),
  };
}

let logSeq = 0;
function log(l: {
  coachId: string;
  coachName?: string;
  startAt?: Date;
  minutes?: number;
  stampedHourly?: number | null;
  stampedFlat?: number | null;
  stampedSource?: RateSourceKind | null;
  id?: string;
}): RepriceLogRow {
  const startAt = l.startAt ?? new Date("2026-07-01T17:00:00Z");
  return {
    id: l.id ?? `log-${++logSeq}`,
    coachId: l.coachId,
    coachName: l.coachName ?? l.coachId,
    coachEmail: `${l.coachId}@pfa.invalid`,
    programId: PROGRAM_ID,
    startAt,
    endAt: new Date(startAt.getTime() + (l.minutes ?? 60) * 60_000),
    ratePer30MinCents: l.stampedHourly ?? null,
    perSessionRateCents: l.stampedFlat ?? null,
    rateSourceKind: l.stampedSource ?? null,
  };
}

function run(args: {
  scope: Parameters<typeof computeRateRepriceDiff>[0]["scope"];
  program: ProgramFixture;
  overrides?: OverrideRow[];
  logs: RepriceLogRow[];
  heldLogs?: RepriceLogRow[];
  effectiveFrom?: Date;
  candidateRate?: RateRepriceCandidate | null;
}) {
  return computeRateRepriceDiff({
    scope: args.scope,
    effectiveFrom: args.effectiveFrom ?? EFFECTIVE_FROM,
    program: args.program,
    overrides: args.overrides ?? [],
    logs: args.logs,
    heldLogs: args.heldLogs ?? [],
    candidateRate: args.candidateRate ?? null,
  });
}

const PROGRAM_SCOPE = {
  kind: "program_default" as const,
  programId: PROGRAM_ID,
};

beforeEach(() => {
  dbDouble.rowsByTable.clear();
  dbDouble.writeAttempts.length = 0;
});

// ─────────────────────────────────────────────────────────────────────────
describe("computeRateRepriceDiff — hourly program default", () => {
  it("re-prices a $0 log to the program default and books it as an INCREASE", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }), // $30/hr
      logs: [log({ coachId: "coach-a", minutes: 120 })],
    });

    expect(result.changedLogCount).toBe(1);
    expect(result.logs[0].oldPayCents).toBe(0);
    expect(result.logs[0].newPayCents).toBe(6000); // 2h × $30
    expect(result.logs[0].newRatePer30MinCents).toBe(1500);
    expect(result.logs[0].newPerSessionRateCents).toBeNull();
    expect(result.logs[0].newRateSourceKind).toBe("program_default");
    expect(result.increases.logCount).toBe(1);
    expect(result.increases.totalDeltaCents).toBe(6000);
    expect(result.decreases.logCount).toBe(0);
    expect(result.totalDeltaCents).toBe(6000);
    expect(result.excludedCoaches).toEqual([]);
  });

  it("prices exact minutes, not 30-min slots (a 45-min block is 0.75×)", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 2200 }), // $44/hr
      logs: [log({ coachId: "coach-a", minutes: 45 })],
    });
    expect(result.logs[0].newPayCents).toBe(3300);
  });

  it("groups every log of one (coach, program) under a single rollup", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1000 }),
      logs: [
        log({ coachId: "coach-a", minutes: 60 }),
        log({ coachId: "coach-a", minutes: 30 }),
        log({ coachId: "coach-b", minutes: 60 }),
      ],
    });
    expect(result.groups).toHaveLength(2);
    const a = result.groups.find((g) => g.coachId === "coach-a")!;
    expect(a.logCount).toBe(2);
    expect(a.newTotalPayCents).toBe(2000 + 1000);
    expect(a.deltaCents).toBe(3000);
    expect(a.newRatePer30MinCents).toBe(1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("computeRateRepriceDiff — PER-SESSION is FLAT (migration 0052 bug class)", () => {
  // The shipped bug: a flat per-game fee was faked with an hourly rate, so a
  // 3.5-hour game paid $350 instead of $100. A re-price must stamp the flat
  // amount as the per-session snapshot and value it at exactly that amount,
  // for ANY duration — never halved like the per-30-min field.
  it.each([30, 60, 210])(
    "re-prices a %i-minute log to the exact flat amount",
    (minutes) => {
      const result = run({
        scope: PROGRAM_SCOPE,
        program: program({ payMode: "per_session", flat: 10_000 }), // $100/game
        logs: [log({ coachId: "coach-a", minutes })],
      });

      expect(result.logs[0].newPerSessionRateCents).toBe(10_000);
      // The hourly snapshot is cleared: a per-session program has no hourly
      // basis of its own, so leaving a stale number there would mislead.
      expect(result.logs[0].newRatePer30MinCents).toBeNull();
      expect(result.logs[0].newPayCents).toBe(10_000);
      expect(result.logs[0].newRateSourceKind).toBe("program_default");
    },
  );

  it("stamps a per-session OVERRIDE flat, whatever the program pays", () => {
    const result = run({
      scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
      program: program({ hourly: 1500 }),
      overrides: [
        override({ coachId: "coach-a", payMode: "per_session", flat: 7_500 }),
      ],
      logs: [log({ coachId: "coach-a", minutes: 240 })],
    });
    expect(result.logs[0].newPerSessionRateCents).toBe(7_500);
    expect(result.logs[0].newPayCents).toBe(7_500);
    expect(result.logs[0].newRateSourceKind).toBe("override");
  });

  it("keeps an HOURLY override coach on the clock on a per-session program", () => {
    // Precedence, not pay mode: a (coach, program) override wins outright,
    // including an hourly one on a per-session program.
    const result = run({
      scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
      program: program({ payMode: "per_session", flat: 10_000 }),
      overrides: [
        override({ coachId: "coach-a", payMode: "hourly", hourly: 2000 }),
      ],
      logs: [log({ coachId: "coach-a", minutes: 120 })],
    });
    expect(result.logs[0].newPerSessionRateCents).toBeNull();
    expect(result.logs[0].newRatePer30MinCents).toBe(2000);
    expect(result.logs[0].newPayCents).toBe(8000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("SPEC §5 — the exclusion rule is structural", () => {
  it("cannot reach a coach whose logs resolve from their own override", () => {
    // Both coaches' logs are FED IN. The override coach is not filtered out
    // anywhere — she is re-resolved, lands on her override at step 1, and so
    // the program default was never consulted for her logs.
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 3000 }),
      overrides: [
        override({ coachId: "coach-o", payMode: "hourly", hourly: 2000 }),
      ],
      logs: [
        log({ coachId: "coach-a", coachName: "Ann", minutes: 60 }),
        log({ coachId: "coach-o", coachName: "Omar", minutes: 60 }),
        log({ coachId: "coach-o", coachName: "Omar", minutes: 60 }),
      ],
    });

    expect(result.logs.map((l) => l.coachId)).toEqual(["coach-a"]);
    expect(result.excludedLogCount).toBe(2);
    expect(result.excludedCoaches).toEqual([
      {
        coachId: "coach-o",
        coachName: "Omar",
        logCount: 2,
        reason: "resolves_from_own_override",
      },
    ]);
    // And the excluded coach contributes nothing to the money totals.
    expect(result.totalDeltaCents).toBe(3000 * 2 - 0);
  });

  it("still excludes an override coach whose OLD stamp came from the default", () => {
    // SPEC §5, stated consequence: a coach with an override NOW, whose past
    // logs were stamped from the default BEFORE that override existed, is
    // skipped by the program retro. Those logs are fixed by running the retro
    // on THEIR override instead — two tools, no double-application.
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 3000 }),
      overrides: [
        override({ coachId: "coach-o", payMode: "hourly", hourly: 2000 }),
      ],
      logs: [
        log({
          coachId: "coach-o",
          minutes: 60,
          stampedHourly: 1000,
          stampedSource: "program_default",
        }),
      ],
    });
    expect(result.changedLogCount).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.excludedLogCount).toBe(1);
  });

  it("DOES reach that same coach when the retro is run on their override", () => {
    const result = run({
      scope: { kind: "override", coachId: "coach-o", programId: PROGRAM_ID },
      program: program({ hourly: 3000 }),
      overrides: [
        override({ coachId: "coach-o", payMode: "hourly", hourly: 2000 }),
      ],
      logs: [
        log({
          coachId: "coach-o",
          minutes: 60,
          stampedHourly: 1000,
          stampedSource: "program_default",
        }),
      ],
    });
    expect(result.changedLogCount).toBe(1);
    expect(result.logs[0].newRatePer30MinCents).toBe(2000);
    expect(result.logs[0].newRateSourceKind).toBe("override");
    expect(result.excludedCoaches).toEqual([]);
  });

  it("an override that supplies NO rate is not an exclusion", () => {
    // An hourly override row with a null rate supplies nothing; the program
    // default IS this log's rate source, so the retro reaches it. The rule is
    // "who supplied the rate", never "does a row exist".
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 2500 }),
      overrides: [
        override({ coachId: "coach-a", payMode: "hourly", hourly: null }),
      ],
      logs: [log({ coachId: "coach-a", minutes: 60 })],
    });
    expect(result.excludedCoaches).toEqual([]);
    expect(result.changedLogCount).toBe(1);
    expect(result.logs[0].newRateSourceKind).toBe("program_default");
    expect(result.logs[0].newRatePer30MinCents).toBe(2500);
  });

  it("an override-scoped retro leaves every OTHER coach out of scope", () => {
    const result = run({
      scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
      program: program({ hourly: 3000 }),
      overrides: [
        override({ coachId: "coach-a", payMode: "hourly", hourly: 5000 }),
      ],
      logs: [
        log({ coachId: "coach-a", minutes: 60 }),
        log({ coachId: "coach-b", minutes: 60 }),
      ],
    });
    expect(result.logs.map((l) => l.coachId)).toEqual(["coach-a"]);
    expect(result.scannedLogCount).toBe(1);
    // coach-b is out of SCOPE, which is not the same thing as §5-excluded.
    expect(result.excludedCoaches).toEqual([]);
    expect(result.excludedLogCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("candidate rate — the diff answers 'what WOULD this rate do' (SPEC §7)", () => {
  // Phase D1. The engine re-resolves from persisted rows, so without this the
  // inline preview could only ever describe the rate ALREADY SAVED — it would
  // quote Mark one number and then write another. A candidate substitutes the
  // not-yet-saved rate into the rows handed to the resolvers.

  it("prices against the CANDIDATE program default, not the persisted one", () => {
    const logs = () => [log({ coachId: "coach-a", minutes: 120 })];
    const persisted = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }), // $30/hr saved
      logs: logs(),
    });
    const candidate = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: logs(),
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 2500, // $50/hr typed, not yet saved
      },
    });

    // The whole point: the two disagree, and the candidate one is the truth
    // about what Save is about to do.
    expect(persisted.logs[0].newPayCents).toBe(6000);
    expect(candidate.logs[0].newPayCents).toBe(10_000);
    expect(candidate.logs[0].newRatePer30MinCents).toBe(2500);
    expect(candidate.totalDeltaCents).toBe(10_000);
    expect(candidate.totalDeltaCents).not.toBe(persisted.totalDeltaCents);
    expect(candidate.candidateRate).toEqual({
      kind: "program_default",
      payMode: "hourly",
      defaultRatePer30MinCents: 2500,
    });
    expect(persisted.candidateRate).toBeNull();
  });

  it("prices against the CANDIDATE override, not the persisted one", () => {
    const scope = {
      kind: "override" as const,
      coachId: "coach-a",
      programId: PROGRAM_ID,
    };
    const args = {
      scope,
      program: program({ hourly: 1000 }),
      overrides: [
        override({ coachId: "coach-a", payMode: "hourly", hourly: 2000 }),
      ],
    };
    const persisted = run({ ...args, logs: [log({ coachId: "coach-a", minutes: 60 })] });
    const candidate = run({
      ...args,
      logs: [log({ coachId: "coach-a", minutes: 60 })],
      candidateRate: {
        kind: "override",
        payMode: "hourly",
        ratePer30MinCents: 3500,
      },
    });

    expect(persisted.logs[0].newPayCents).toBe(4000); // $40/hr saved
    expect(candidate.logs[0].newPayCents).toBe(7000); // $70/hr typed
    expect(candidate.logs[0].newRatePer30MinCents).toBe(3500);
    expect(candidate.logs[0].newRateSourceKind).toBe("override");
  });

  it("previews an override that does not exist yet (the first-time case)", () => {
    // No persisted override row at all. The candidate IS the hypothetical
    // row — which is exactly the state the dialog is in when Mark types a
    // coach's first rate on a program.
    const result = run({
      scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
      program: program({ hourly: 1000 }),
      overrides: [],
      logs: [
        log({
          coachId: "coach-a",
          minutes: 60,
          stampedHourly: 1000,
          stampedSource: "program_default",
        }),
      ],
      candidateRate: {
        kind: "override",
        payMode: "hourly",
        ratePer30MinCents: 4000,
      },
    });
    expect(result.changedLogCount).toBe(1);
    expect(result.logs[0].newRatePer30MinCents).toBe(4000);
    expect(result.logs[0].newRateSourceKind).toBe("override");
    expect(result.logs[0].oldPayCents).toBe(2000);
    expect(result.logs[0].newPayCents).toBe(8000);
  });

  it.each([30, 60, 210])(
    "a PER-SESSION candidate is flat on a %i-minute log (0052 bug class)",
    (minutes) => {
      const asProgram = run({
        scope: PROGRAM_SCOPE,
        program: program({ hourly: 1500 }), // persisted: hourly
        logs: [log({ coachId: "coach-a", minutes })],
        candidateRate: {
          kind: "program_default",
          payMode: "per_session",
          defaultPerSessionRateCents: 10_000, // $100/game typed
        },
      });
      expect(asProgram.logs[0].newPerSessionRateCents).toBe(10_000);
      expect(asProgram.logs[0].newRatePer30MinCents).toBeNull();
      expect(asProgram.logs[0].newPayCents).toBe(10_000);

      const asOverride = run({
        scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
        program: program({ hourly: 1500 }),
        overrides: [
          override({ coachId: "coach-a", payMode: "hourly", hourly: 2000 }),
        ],
        logs: [log({ coachId: "coach-a", minutes })],
        candidateRate: {
          kind: "override",
          payMode: "per_session",
          perSessionRateCents: 7_500,
        },
      });
      expect(asOverride.logs[0].newPerSessionRateCents).toBe(7_500);
      // The hourly slot keeps the (hourly) PROGRAM's default here — exactly
      // what resolveRateCentsForProgram does for a per-session override on an
      // hourly program today. It is inert: workPayForLog reads the flat
      // amount ahead of it, so the pay is $75 at every duration.
      expect(asOverride.logs[0].newRatePer30MinCents).toBe(1500);
      expect(asOverride.logs[0].newPayCents).toBe(7_500);
    },
  );

  it("SPEC §5 STILL HOLDS with a candidate: a program candidate cannot reach an override coach", () => {
    // The candidate replaces the PROGRAM's pay config and nothing else. Omar
    // holds his own override, so he resolves at step 1 no matter what number
    // is typed into the program default — and is still reported by name.
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      overrides: [
        override({ coachId: "coach-o", payMode: "hourly", hourly: 2000 }),
      ],
      logs: [
        log({ coachId: "coach-a", coachName: "Ann", minutes: 60 }),
        log({ coachId: "coach-o", coachName: "Omar", minutes: 60 }),
        log({ coachId: "coach-o", coachName: "Omar", minutes: 60 }),
      ],
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 9_900, // absurdly high, on purpose
      },
    });

    expect(result.logs.map((l) => l.coachId)).toEqual(["coach-a"]);
    expect(result.excludedLogCount).toBe(2);
    expect(result.excludedCoaches).toEqual([
      {
        coachId: "coach-o",
        coachName: "Omar",
        logCount: 2,
        reason: "resolves_from_own_override",
      },
    ]);
    // Omar contributes nothing to the money, and Ann gets the CANDIDATE rate.
    expect(result.totalDeltaCents).toBe(9_900 * 2);
    expect(result.logs[0].newRatePer30MinCents).toBe(9_900);
  });

  it("a per-session program candidate still cannot reach an override coach", () => {
    // Same rule through the other pay mode: flipping the PROGRAM to a flat
    // per-game fee does not reach a coach with her own hourly override.
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      overrides: [
        override({ coachId: "coach-o", payMode: "hourly", hourly: 2000 }),
      ],
      logs: [log({ coachId: "coach-o", coachName: "Omar", minutes: 210 })],
      candidateRate: {
        kind: "program_default",
        payMode: "per_session",
        defaultPerSessionRateCents: 10_000,
      },
    });
    expect(result.changedLogCount).toBe(0);
    expect(result.excludedCoaches.map((c) => c.coachName)).toEqual(["Omar"]);
  });

  it("a candidate EQUAL to the persisted rate produces the identical diff", () => {
    const logs = () => [
      log({ coachId: "coach-a", minutes: 60, id: "log-fixed-1" }),
      log({
        coachId: "coach-b",
        minutes: 90,
        stampedHourly: 1500,
        stampedSource: "program_default",
        id: "log-fixed-2",
      }),
    ];
    const none = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: logs(),
    });
    const same = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: logs(),
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 1500,
      },
    });
    // Everything except the echoed candidate is byte-identical — a candidate
    // is a substitution, never a different code path.
    expect({ ...same, candidateRate: null }).toEqual(none);
  });

  it("refuses a candidate whose kind does not match the scope", () => {
    // The one shape that could have dressed a §5-excluded coach up as
    // reachable: an override candidate smuggled into a program-default retro.
    expect(() =>
      run({
        scope: PROGRAM_SCOPE,
        program: program({ hourly: 1500 }),
        logs: [log({ coachId: "coach-a" })],
        candidateRate: {
          kind: "override",
          payMode: "hourly",
          ratePer30MinCents: 5000,
        },
      }),
    ).toThrow(/cannot be applied to a "program_default"/);
  });

  it("substitutes only the SCOPED coach's override, never another's", () => {
    const result = run({
      scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
      program: program({ hourly: 1000 }),
      overrides: [
        override({ coachId: "coach-a", payMode: "hourly", hourly: 2000 }),
        override({ coachId: "coach-b", payMode: "hourly", hourly: 3000 }),
      ],
      logs: [
        log({ coachId: "coach-a", minutes: 60 }),
        log({ coachId: "coach-b", minutes: 60 }),
      ],
      candidateRate: {
        kind: "override",
        payMode: "hourly",
        ratePer30MinCents: 8000,
      },
    });
    // coach-b is out of scope entirely and her override is untouched.
    expect(result.logs.map((l) => l.coachId)).toEqual(["coach-a"]);
    expect(result.logs[0].newRatePer30MinCents).toBe(8000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("decrease detection (SPEC §6 — the harder confirm)", () => {
  it("separates decreases and names each coach and what they lose", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1000 }), // dropped from $40/hr to $20/hr
      logs: [
        log({
          coachId: "coach-a",
          coachName: "Ann",
          minutes: 60,
          stampedHourly: 2000,
          stampedSource: "program_default",
        }),
        log({
          coachId: "coach-b",
          coachName: "Bo",
          minutes: 120,
          stampedHourly: 2000,
          stampedSource: "program_default",
        }),
      ],
    });

    expect(result.increases.logCount).toBe(0);
    expect(result.decreases.logCount).toBe(2);
    expect(result.decreases.oldTotalPayCents).toBe(4000 + 8000);
    expect(result.decreases.newTotalPayCents).toBe(2000 + 4000);
    expect(result.decreases.totalDeltaCents).toBe(-6000);
    // Sorted by the size of the hit, so the confirm leads with the worst.
    expect(result.decreases.byCoach.map((c) => [c.coachName, c.deltaCents])).toEqual([
      ["Bo", -4000],
      ["Ann", -2000],
    ]);
    expect(result.totalDeltaCents).toBe(-6000);
  });

  it("books increases and decreases in the same run separately", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [
        log({ coachId: "coach-a", minutes: 60, stampedHourly: 1000, stampedSource: "program_default" }),
        log({ coachId: "coach-b", minutes: 60, stampedHourly: 2000, stampedSource: "program_default" }),
      ],
    });
    expect(result.increases.totalDeltaCents).toBe(1000);
    expect(result.decreases.totalDeltaCents).toBe(-1000);
    expect(result.totalDeltaCents).toBe(0);
    expect(result.changedLogCount).toBe(2);
  });

  it("a provenance-only change is written but lands in neither bucket", () => {
    // Rate identical, rateSourceKind was never stamped (a pre-0054 row). The
    // row must still be written so the provenance column stops lying, but no
    // money moves.
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [
        log({ coachId: "coach-a", minutes: 60, stampedHourly: 1500, stampedSource: null }),
      ],
    });
    expect(result.changedLogCount).toBe(1);
    expect(result.logs[0].deltaCents).toBe(0);
    expect(result.increases.logCount).toBe(0);
    expect(result.decreases.logCount).toBe(0);
    expect(result.logs[0].newRateSourceKind).toBe("program_default");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("no-op / empty cases (the idempotence property)", () => {
  it("writes nothing when every log already carries the resolved values", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [
        log({ coachId: "coach-a", minutes: 60, stampedHourly: 1500, stampedSource: "program_default" }),
        log({ coachId: "coach-b", minutes: 90, stampedHourly: 1500, stampedSource: "program_default" }),
      ],
    });
    expect(result.changedLogCount).toBe(0);
    expect(result.unchangedLogCount).toBe(2);
    expect(result.groups).toEqual([]);
    expect(result.logs).toEqual([]);
    expect(result.totalDeltaCents).toBe(0);
    expect(result.increases).toEqual(result.decreases);
  });

  it("handles a program with no logs at all", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [],
    });
    expect(result.scannedLogCount).toBe(0);
    expect(result.changedLogCount).toBe(0);
    expect(result.excludedCoaches).toEqual([]);
    expect(result.oldTotalPayCents).toBe(0);
    expect(result.newTotalPayCents).toBe(0);
  });

  it("stays a no-op when neither the override nor the program sets a rate", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: null }),
      logs: [log({ coachId: "coach-a", minutes: 60, stampedSource: "none" })],
    });
    expect(result.changedLogCount).toBe(0);
    expect(result.unchangedLogCount).toBe(1);
  });

  it("never re-prices a log dated before the effective date", () => {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      effectiveFrom: new Date("2026-07-01T00:00:00Z"),
      logs: [
        log({ coachId: "coach-a", startAt: new Date("2026-06-30T17:00:00Z") }),
        log({ coachId: "coach-a", startAt: new Date("2026-07-01T00:00:00Z") }),
      ],
    });
    // Exactly the boundary log — `>=`, so the log dated ON the effective
    // date is in, the one before it is not.
    expect(result.scannedLogCount).toBe(1);
    expect(result.changedLogCount).toBe(1);
    expect(result.logs[0].startAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("ignores a log belonging to a different program", () => {
    const stray = log({ coachId: "coach-a" });
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [{ ...stray, programId: "some-other-program" }],
    });
    expect(result.scannedLogCount).toBe(0);
    expect(result.changedLogCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("parity with the production resolvers", () => {
  it("never disagrees with what a fresh log would be stamped", () => {
    // The whole point of importing the resolvers instead of reimplementing
    // them: sweep the branch space and assert the engine's "new" values are
    // literally what logHourInternal would stamp today, and that the pay it
    // reports is what workPayForLog returns for those stamps.
    const overrides: (OverrideRow | null)[] = [
      null,
      override({ coachId: "coach-a", payMode: "hourly", hourly: 2000 }),
      override({ coachId: "coach-a", payMode: "hourly", hourly: null }),
      override({ coachId: "coach-a", payMode: "per_session", flat: 7500 }),
      override({ coachId: "coach-a", payMode: "per_session", flat: 0 }),
    ];
    const programFixtures = [
      program({ hourly: 1500 }),
      program({ payMode: "per_session", flat: 10_000 }),
      program({ hourly: null }),
      program({ payMode: "per_session", flat: null }),
    ];

    for (const o of overrides) {
      for (const p of programFixtures) {
        for (const minutes of [30, 45, 210]) {
          const result = run({
            scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
            program: p,
            overrides: o ? [o] : [],
            logs: [log({ coachId: "coach-a", minutes })],
          });
          const where = `override=${JSON.stringify(o)} program=${JSON.stringify(p)} minutes=${minutes}`;

          const expectedHourly = resolveRateCentsForProgram(o, p);
          const expectedFlat = resolvePerSessionRateCents(o, p);
          const expectedKind = resolveRateSourceKind(o, p);
          const changed =
            expectedHourly !== null ||
            expectedFlat !== null ||
            expectedKind !== null;

          if (!changed) continue;
          expect(result.changedLogCount, where).toBe(1);
          const diff = result.logs[0];
          expect(diff.newRatePer30MinCents, where).toBe(expectedHourly);
          expect(diff.newPerSessionRateCents, where).toBe(expectedFlat);
          expect(diff.newRateSourceKind, where).toBe(expectedKind);
          expect(diff.newPayCents, where).toBe(
            workPayForLog({
              perSessionRateCents: expectedFlat,
              startAt: diff.startAt,
              endAt: diff.endAt,
              ratePer30MinCents: expectedHourly,
            }),
          );
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
describe("provenance-only rows are written but never counted as a re-price", () => {
  // `rate_source_kind` shipped nullable with NO BACKFILL, so on the first
  // production run every pre-existing hour_logs row has a NULL provenance.
  // `isDistinct` includes provenance, so every in-window log lands in
  // `changed` with deltaCents = 0 — and the confirm screen claimed to be
  // re-pricing 214 entries when 6 moved money.
  const PROGRAM = program({ hourly: 1500 }); // $30/hr

  function firstProdRun() {
    return run({
      scope: PROGRAM_SCOPE,
      program: PROGRAM,
      logs: [
        // Six rows already paying $30/hr, provenance NULL: written, $0 moved.
        ...[1, 2, 3, 4, 5, 6].map((n) =>
          log({
            coachId: "coach-a",
            coachName: "Ann",
            id: `already-${n}`,
            minutes: 60,
            stampedHourly: 1500,
            stampedSource: null,
          }),
        ),
        // Two rows genuinely under-paid at $20/hr.
        ...[1, 2].map((n) =>
          log({
            coachId: "coach-b",
            coachName: "Bo",
            id: `underpaid-${n}`,
            minutes: 60,
            stampedHourly: 1000,
            stampedSource: null,
          }),
        ),
      ],
    });
  }

  it("still WRITES the provenance-only rows — the column has to stop lying", () => {
    const r = firstProdRun();
    expect(r.changedLogCount).toBe(8);
    expect(r.groups.flatMap((g) => g.logs)).toHaveLength(8);
    expect(r.provenanceOnlyLogCount).toBe(6);
  });

  it("counts only the rows whose PAY moves in the confirmable set", () => {
    const r = firstProdRun();
    expect(r.payChanged.logCount).toBe(2);
    expect(r.payChanged.logs.map((l) => l.logId).sort()).toEqual([
      "underpaid-1",
      "underpaid-2",
    ]);
    // $20/hr → $30/hr on two 1-hour logs (rates are stored PER 30 MIN).
    expect(r.payChanged.oldTotalPayCents).toBe(4_000);
    expect(r.payChanged.newTotalPayCents).toBe(6_000);
  });

  it("🔒 moves not one cent: the delta is identical either way", () => {
    const r = firstProdRun();
    expect(r.payChanged.totalDeltaCents).toBe(r.totalDeltaCents);
    expect(r.totalDeltaCents).toBe(2_000);
  });

  it("reaches a TRUE no-op when only provenance moved", () => {
    const r = run({
      scope: PROGRAM_SCOPE,
      program: PROGRAM,
      logs: [
        log({ coachId: "coach-a", minutes: 60, stampedHourly: 1500, stampedSource: null }),
        log({ coachId: "coach-a", minutes: 60, stampedHourly: 1500, stampedSource: null }),
      ],
    });
    // Rows are written (provenance), but nothing is being re-priced.
    expect(r.changedLogCount).toBe(2);
    expect(r.provenanceOnlyLogCount).toBe(2);
    expect(r.payChanged.logCount).toBe(0);
    expect(r.totalDeltaCents).toBe(0);
    expect(r.scannedLogCount).toBe(2);
  });

  it("does not count a real rate change as provenance-only", () => {
    const r = run({
      scope: PROGRAM_SCOPE,
      program: PROGRAM,
      logs: [log({ coachId: "coach-a", minutes: 60, stampedHourly: 1000, stampedSource: "program_default" })],
    });
    expect(r.provenanceOnlyLogCount).toBe(0);
    expect(r.payChanged.logCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("held entries in the window are counted, never touched", () => {
  // SPEC §6: held logs aren't payable yet, so they are skipped. But
  // `approveHeldHourLogInternal` only flips the status — it never re-resolves
  // the rate — so approving one after a retro posts it at its ORIGINAL stamp.
  // The count is the signal. It is INFORMATIONAL: no dollar depends on it.
  it("reports held logs in scope + window without pricing them", () => {
    const r = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [log({ coachId: "coach-a", minutes: 60, stampedHourly: 1000, stampedSource: "program_default" })],
      heldLogs: [
        log({ coachId: "coach-a", minutes: 60, stampedHourly: null, stampedSource: null }),
        log({ coachId: "coach-b", minutes: 60, stampedHourly: null, stampedSource: null }),
      ],
    });
    expect(r.heldLogCount).toBe(2);
    // Untouched by every money-bearing figure.
    expect(r.scannedLogCount).toBe(1);
    expect(r.changedLogCount).toBe(1);
    expect(r.logs).toHaveLength(1);
    expect(r.oldTotalPayCents).toBe(2_000);
    expect(r.newTotalPayCents).toBe(3_000);
  });

  it("ignores held logs dated before the effective date", () => {
    const r = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [],
      heldLogs: [
        log({ coachId: "coach-a", startAt: new Date("2026-05-01T17:00:00Z") }),
        log({ coachId: "coach-a", startAt: new Date("2026-07-01T17:00:00Z") }),
      ],
    });
    expect(r.heldLogCount).toBe(1);
  });

  it("ignores held logs for a coach the §5 exclusion puts out of reach", () => {
    const r = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      overrides: [override({ coachId: "coach-b", payMode: "hourly", hourly: 2000 })],
      logs: [],
      heldLogs: [
        log({ coachId: "coach-a" }),
        log({ coachId: "coach-b" }), // resolves from her own override
      ],
    });
    expect(r.heldLogCount).toBe(1);
  });

  it("counts only the scoped coach on an override retro", () => {
    const r = run({
      scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
      program: program({ hourly: 1500 }),
      overrides: [override({ coachId: "coach-a", payMode: "hourly", hourly: 2500 })],
      logs: [],
      heldLogs: [log({ coachId: "coach-a" }), log({ coachId: "coach-b" })],
    });
    expect(r.heldLogCount).toBe(1);
  });

  it("is zero when none are held", () => {
    const r = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [log({ coachId: "coach-a" })],
    });
    expect(r.heldLogCount).toBe(0);
  });
});

describe("the audit row cannot drift from every other writer's", () => {
  // The re-price engine puts its audit insert INSIDE its db.batch (so the
  // write is atomic with the money) instead of going through logAudit. That
  // is only safe while both produce the IDENTICAL row — otherwise
  // audit_log.diff means different things depending on which path wrote it.
  // This is the test that keeps them honest.
  function repriceAuditInput(): LogAuditInput {
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }),
      logs: [
        log({ coachId: "coach-a", coachName: "Ann", minutes: 120 }),
        log({
          coachId: "coach-a",
          coachName: "Ann",
          minutes: 45,
          stampedHourly: 1000,
          stampedSource: "program_default",
        }),
      ],
    });
    return buildRepriceAuditInput({
      actorId: "admin-1",
      scope: PROGRAM_SCOPE,
      effectiveFrom: EFFECTIVE_FROM,
      group: result.groups[0],
    });
  }

  it("is byte-identical to what logAudit would have inserted", async () => {
    const input = repriceAuditInput();

    // Capture the exact values logAudit hands to the driver.
    let captured: unknown;
    const capturingDb = {
      insert: () => ({
        values: (v: unknown) => {
          captured = v;
          return Promise.resolve();
        },
      }),
    };
    await logAudit(capturingDb as never, input);

    // ...and what the engine puts in its batch, via the shared builder.
    const inBatch = buildAuditRowValues(input);

    expect(JSON.stringify(inBatch)).toBe(JSON.stringify(captured));
    expect(inBatch).toEqual(captured);
  });

  it("carries enough old state to reconstruct every re-priced log", () => {
    const input = repriceAuditInput();
    const row = buildAuditRowValues(input);

    expect(row.entityType).toBe("hour_log_reprice");
    expect(row.entityId).toBe(`coach-a::${PROGRAM_ID}`);
    expect(row.action).toBe("update");

    const diff = row.diff as {
      before: {
        logs: {
          id: string;
          startAt: string;
          ratePer30MinCents: number | null;
          perSessionRateCents: number | null;
          rateSourceKind: RateSourceKind | null;
          payCents: number;
        }[];
      };
      after: { logs: { id: string; payCents: number }[] };
    };
    // shallowDiff keeps both sides because they differ — the reversibility
    // payload survives the diff shaping.
    expect(diff.before.logs).toHaveLength(2);
    for (const l of diff.before.logs) {
      expect(l).toHaveProperty("id");
      expect(l).toHaveProperty("startAt");
      expect(l).toHaveProperty("ratePer30MinCents");
      expect(l).toHaveProperty("perSessionRateCents");
      expect(l).toHaveProperty("rateSourceKind");
      expect(l).toHaveProperty("payCents");
    }
    // The old rates, not the new ones: $0 (unrated) and $20/hr.
    expect(diff.before.logs.map((l) => l.ratePer30MinCents).sort()).toEqual([
      1000,
      null,
    ]);
    expect(diff.after.logs.map((l) => l.payCents).sort((a, b) => a - b)).toEqual(
      [2250, 6000],
    );
  });

  it("🔴 keeps the group total on a NET-ZERO group", () => {
    // The re-price audit used `action: "update"` with both snapshots, so
    // `shallowDiff` stripped every key identical on both sides — including
    // `totalPayCents` when old equalled new. Per-log data survived (the arrays
    // always differ), so reversibility held, but the group total vanished from
    // exactly the rows a reader would want it on: the ones where the money
    // came out even. `diffMode: "full"` stores the report whole.
    //
    // A net-zero group, built for real: one coach, one log up $10 and one down
    // $10 under the same new rate. 60 min at $30/hr = $30; 30 min at $30/hr =
    // $15. Old stamps: $20/hr (=$20) and $60/hr (=$30 for 30 min → $30).
    const result = run({
      scope: PROGRAM_SCOPE,
      program: program({ hourly: 1500 }), // $30/hr
      logs: [
        log({ coachId: "coach-a", coachName: "Ann", minutes: 60, stampedHourly: 2000, stampedSource: "program_default" }),
        log({ coachId: "coach-a", coachName: "Ann", minutes: 60, stampedHourly: 1000, stampedSource: "program_default" }),
      ],
    });
    const group = result.groups[0];
    // 60 min: $40 → $30 (−$10). 60 min: $20 → $30 (+$10). Net zero.
    expect(group.oldTotalPayCents).toBe(group.newTotalPayCents);
    expect(group.deltaCents).toBe(0);

    const row = buildAuditRowValues(
      buildRepriceAuditInput({
        actorId: "admin-1",
        scope: PROGRAM_SCOPE,
        effectiveFrom: EFFECTIVE_FROM,
        group,
      }),
    );
    const diff = row.diff as {
      before: { totalPayCents?: number; logs: unknown[] };
      after: { totalPayCents?: number; deltaCents?: number; logs: unknown[] };
    };
    expect(diff.before.totalPayCents).toBe(group.oldTotalPayCents);
    expect(diff.after.totalPayCents).toBe(group.newTotalPayCents);
    expect(diff.after.deltaCents).toBe(0);
    // …and the reversibility payload is still all there.
    expect(diff.before.logs).toHaveLength(2);
    expect(diff.after.logs).toHaveLength(2);
  });

  it("stores the whole report, not a changed-keys diff", () => {
    const row = buildAuditRowValues(repriceAuditInput());
    const diff = row.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    // Every key the builder wrote survives, even on a group where the total
    // happens to match — nothing is elided.
    expect(Object.keys(diff.before).sort()).toEqual(["logs", "totalPayCents"]);
    expect(diff.after).toHaveProperty("scope");
    expect(diff.after).toHaveProperty("effectiveFrom");
    expect(diff.after).toHaveProperty("totalPayCents");
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("previewRateReprice — provably write-free", () => {
  function seed(args: {
    program?: Record<string, unknown>;
    overrides?: unknown[];
    logs?: unknown[];
  }) {
    dbDouble.rowsByTable.set(programs, [
      args.program ?? {
        id: PROGRAM_ID,
        name: "Elite Hitting",
        payMode: "hourly",
        defaultRatePer30MinCents: 1500,
        defaultPerSessionRateCents: null,
      },
    ]);
    dbDouble.rowsByTable.set(programRateOverrides, args.overrides ?? []);
    dbDouble.rowsByTable.set(hourLogs, args.logs ?? []);
  }

  it("touches only SELECT — insert/update/delete/batch all throw if called", async () => {
    seed({
      logs: [
        {
          id: "log-1",
          coachId: "coach-a",
          coachName: "Ann",
          coachEmail: "ann@pfa.invalid",
          programId: PROGRAM_ID,
          startAt: new Date("2026-07-01T17:00:00Z"),
          endAt: new Date("2026-07-01T19:00:00Z"),
          ratePer30MinCents: null,
          perSessionRateCents: null,
          rateSourceKind: null,
        },
      ],
    });

    const preview = await previewRateReprice({
      scope: PROGRAM_SCOPE,
      effectiveFrom: EFFECTIVE_FROM,
    });

    expect(preview.changedLogCount).toBe(1);
    expect(preview.logs[0].newPayCents).toBe(6000);
    // The proof: not one mutating method was reached.
    expect(dbDouble.writeAttempts).toEqual([]);
  });

  it("rejects a FUTURE effective date (SPEC §3 — past + present only)", async () => {
    seed({});
    await expect(
      previewRateReprice({
        scope: PROGRAM_SCOPE,
        effectiveFrom: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow(/future/i);
    expect(dbDouble.writeAttempts).toEqual([]);
  });

  it("throws when the program does not exist", async () => {
    dbDouble.rowsByTable.set(programs, []);
    await expect(
      previewRateReprice({ scope: PROGRAM_SCOPE, effectiveFrom: EFFECTIVE_FROM }),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
  });

  it("throws when an override-scoped retro has no override row", async () => {
    seed({ overrides: [] });
    await expect(
      previewRateReprice({
        scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
        effectiveFrom: EFFECTIVE_FROM,
      }),
    ).rejects.toBeInstanceOf(ProgramRateOverrideNotFoundError);
  });

  // ── SPEC §7 / Phase D1 — the SAME write-free proof, with a candidate. ──
  // Extended, not replaced: every assertion above still runs unchanged, and
  // these repeat them for the new input. If a candidate ever made preview
  // write, `dbDouble.writeAttempts` catches it exactly as before.

  it("prices a CANDIDATE rate and still touches only SELECT", async () => {
    const oneLog = {
      id: "log-1",
      coachId: "coach-a",
      coachName: "Ann",
      coachEmail: "ann@pfa.invalid",
      programId: PROGRAM_ID,
      startAt: new Date("2026-07-01T17:00:00Z"),
      endAt: new Date("2026-07-01T19:00:00Z"),
      ratePer30MinCents: null,
      perSessionRateCents: null,
      rateSourceKind: null,
    };
    seed({ logs: [oneLog] }); // program persists $30/hr

    const withoutCandidate = await previewRateReprice({
      scope: PROGRAM_SCOPE,
      effectiveFrom: EFFECTIVE_FROM,
    });
    const withCandidate = await previewRateReprice({
      scope: PROGRAM_SCOPE,
      effectiveFrom: EFFECTIVE_FROM,
      candidateRate: {
        kind: "program_default",
        payMode: "hourly",
        defaultRatePer30MinCents: 4000, // $80/hr, typed but unsaved
      },
    });

    // Same data, different answer — the candidate really did drive the diff.
    expect(withoutCandidate.logs[0].newPayCents).toBe(6000);
    expect(withCandidate.logs[0].newPayCents).toBe(16_000);
    expect(withCandidate.totalDeltaCents).not.toBe(
      withoutCandidate.totalDeltaCents,
    );
    // The proof, unchanged: not one mutating method was reached.
    expect(dbDouble.writeAttempts).toEqual([]);
  });

  it("previews a candidate override even with NO persisted override row", async () => {
    // Without a candidate this same call throws ProgramRateOverrideNotFound
    // (asserted above). With one, the candidate IS the hypothetical row.
    seed({
      overrides: [],
      logs: [
        {
          id: "log-1",
          coachId: "coach-a",
          coachName: "Ann",
          coachEmail: "ann@pfa.invalid",
          programId: PROGRAM_ID,
          startAt: new Date("2026-07-01T17:00:00Z"),
          endAt: new Date("2026-07-01T18:00:00Z"),
          ratePer30MinCents: 1500,
          perSessionRateCents: null,
          rateSourceKind: "program_default",
        },
      ],
    });

    const preview = await previewRateReprice({
      scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
      effectiveFrom: EFFECTIVE_FROM,
      candidateRate: {
        kind: "override",
        payMode: "per_session",
        perSessionRateCents: 12_500,
      },
    });
    expect(preview.changedLogCount).toBe(1);
    expect(preview.logs[0].newPerSessionRateCents).toBe(12_500);
    expect(preview.logs[0].newPayCents).toBe(12_500);
    expect(preview.logs[0].newRateSourceKind).toBe("override");
    expect(dbDouble.writeAttempts).toEqual([]);
  });

  it("rejects a FUTURE effective date even with a candidate", async () => {
    seed({});
    await expect(
      previewRateReprice({
        scope: PROGRAM_SCOPE,
        effectiveFrom: new Date(Date.now() + 86_400_000),
        candidateRate: {
          kind: "program_default",
          payMode: "hourly",
          defaultRatePer30MinCents: 2000,
        },
      }),
    ).rejects.toThrow(/future/i);
    expect(dbDouble.writeAttempts).toEqual([]);
  });

  it.each([
    [
      "a per-session amount of 0",
      { kind: "override", payMode: "per_session", perSessionRateCents: 0 },
    ],
    [
      "a negative per-session amount",
      { kind: "override", payMode: "per_session", perSessionRateCents: -500 },
    ],
    [
      "a fractional per-session amount",
      { kind: "override", payMode: "per_session", perSessionRateCents: 10.5 },
    ],
    [
      "a per-session amount over the $10,000 cap",
      {
        kind: "override",
        payMode: "per_session",
        perSessionRateCents: 1_000_001,
      },
    ],
    [
      "per-session mode with no amount at all",
      { kind: "override", payMode: "per_session" },
    ],
    [
      "an hourly rate over the $1,000 cap",
      { kind: "override", payMode: "hourly", ratePer30MinCents: 100_001 },
    ],
    ["hourly mode with no rate at all", { kind: "override", payMode: "hourly" }],
  ])("refuses to preview %s — a rate that could never be saved", async (_label, candidateRate) => {
    seed({
      overrides: [
        {
          coachId: "coach-a",
          programId: PROGRAM_ID,
          payMode: "hourly",
          ratePer30MinCents: 2000,
          perSessionRateCents: null,
          effectiveFrom: null,
          updatedAt: new Date(),
        },
      ],
    });
    await expect(
      previewRateReprice({
        scope: { kind: "override", coachId: "coach-a", programId: PROGRAM_ID },
        effectiveFrom: EFFECTIVE_FROM,
        candidateRate,
      }),
    ).rejects.toThrow();
    expect(dbDouble.writeAttempts).toEqual([]);
  });

  it("refuses a candidate whose kind does not match the scope", async () => {
    seed({});
    await expect(
      previewRateReprice({
        scope: PROGRAM_SCOPE,
        effectiveFrom: EFFECTIVE_FROM,
        candidateRate: {
          kind: "override",
          payMode: "hourly",
          ratePer30MinCents: 5000,
        },
      }),
    ).rejects.toThrow(/cannot be previewed against a program_default/);
    expect(dbDouble.writeAttempts).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
describe("🔒 applyRateReprice CANNOT be driven by a candidate rate", () => {
  // SPEC §6: the engine never trusts a caller-supplied preview. A candidate
  // RATE feeding a read-only diff is fine; a caller-supplied rate driving a
  // WRITE is the hole that stays shut. Three independent layers guard it —
  // the type, the schema (which has no such field), and the runtime check.

  const actor = { id: "admin-1" } as Parameters<typeof applyRateReprice>[0];

  it("is a COMPILE error to pass one (RateRepriceApplyInput.candidateRate?: never)", () => {
    const candidateRate: RateRepriceCandidate = {
      kind: "program_default",
      payMode: "hourly",
      defaultRatePer30MinCents: 9_900,
    };
    // Not an object-literal excess-property complaint: a real
    // RateRepriceCandidate is not assignable to `never`, so a Phase-D caller
    // cannot reuse its preview payload for the save even via a variable.
    // `npm run typecheck` covers this file, so this IS the assertion — the
    // unused-directive error fails the build if the lock is ever loosened.
    const applyInput: Parameters<typeof applyRateReprice>[1] = {
      scope: PROGRAM_SCOPE,
      effectiveFrom: EFFECTIVE_FROM,
      // @ts-expect-error — a candidate rate must never reach the write path.
      candidateRate,
    };
    // The same payload minus the candidate compiles fine, so the error above
    // is about the candidate and nothing else.
    const okInput: Parameters<typeof applyRateReprice>[1] = {
      scope: PROGRAM_SCOPE,
      effectiveFrom: EFFECTIVE_FROM,
    };
    expect(applyInput.scope).toEqual(okInput.scope);
  });

  it("throws at runtime rather than silently ignoring one, and writes nothing", async () => {
    dbDouble.rowsByTable.set(programs, [
      {
        id: PROGRAM_ID,
        name: "Elite Hitting",
        payMode: "hourly",
        defaultRatePer30MinCents: 1500,
        defaultPerSessionRateCents: null,
      },
    ]);
    dbDouble.rowsByTable.set(programRateOverrides, []);
    dbDouble.rowsByTable.set(hourLogs, []);

    await expect(
      applyRateReprice(actor, {
        scope: PROGRAM_SCOPE,
        effectiveFrom: EFFECTIVE_FROM,
        // A JS caller (a "use server" boundary erases types) reaching past
        // the compile-time lock.
        candidateRate: {
          kind: "program_default",
          payMode: "hourly",
          defaultRatePer30MinCents: 9_900,
        },
      } as unknown as Parameters<typeof applyRateReprice>[1]),
    ).rejects.toThrow(/does not accept a candidate rate/);

    // It refused BEFORE touching the database at all.
    expect(dbDouble.writeAttempts).toEqual([]);
  });

  it("a null/absent candidateRate key is not treated as one", async () => {
    // The guard must not turn a harmless serialization artifact into a
    // refusal — only an actual candidate is rejected.
    dbDouble.rowsByTable.set(programs, [
      {
        id: PROGRAM_ID,
        name: "Elite Hitting",
        payMode: "hourly",
        defaultRatePer30MinCents: 1500,
        defaultPerSessionRateCents: null,
      },
    ]);
    dbDouble.rowsByTable.set(programRateOverrides, []);
    dbDouble.rowsByTable.set(hourLogs, []);

    const result = await applyRateReprice(actor, {
      scope: PROGRAM_SCOPE,
      effectiveFrom: EFFECTIVE_FROM,
      candidateRate: null,
    } as unknown as Parameters<typeof applyRateReprice>[1]);
    // No logs → the idempotent early return, so no write was attempted.
    expect(result.appliedLogCount).toBe(0);
    expect(result.preview.candidateRate).toBeNull();
    expect(dbDouble.writeAttempts).toEqual([]);
  });
});
