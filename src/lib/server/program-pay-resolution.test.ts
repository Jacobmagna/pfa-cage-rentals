// Unit tests for the two PURE pay-snapshot resolvers, across the full
// (override x program) branch space. These decide what money is stamped on
// every hour_logs row, so the matrix is exhaustive rather than illustrative.
//
// Migration 0052 added PROGRAM-level per-session pay. The bug it fixes, in
// one line: "HS Summer Travel - Game" pays a flat $100 PER GAME, but the only
// per-session setting lived on the per-(coach, program) override — so the
// program had to be faked with an hourly rate, and a 3.5-hour game paid $350.
//
// Two invariants these tests exist to protect:
//   1. BACKWARD COMPATIBILITY — every program that existed before 0052
//      backfills to payMode "hourly", and for those the resolvers must behave
//      EXACTLY as they did before. A regression here silently re-rates a live
//      payroll.
//   2. PRECEDENCE — a (coach, program) override always beats the program
//      default, including an HOURLY override on a PER-SESSION program.

import { describe, expect, it, vi } from "vitest";

// The resolvers under test are PURE, but they live in a module that opens a
// DB client at import time (@/db throws without DATABASE_URL). Mock that one
// boundary so this stays a real unit test — same convention as
// src/app/actions.test.ts. vi.mock is hoisted above the imports below.
vi.mock("@/db", () => ({ db: {} }));

import {
  resolvePerSessionRateCents,
  resolveRateCentsForProgram,
  resolveRateSourceKind,
  type ProgramPayConfig,
} from "./hour-log-actions";
import { workPayForLog } from "@/lib/billing";

type Override = Parameters<typeof resolveRateCentsForProgram>[0];

function override(o: {
  payMode: "hourly" | "per_session";
  ratePer30MinCents?: number | null;
  perSessionRateCents?: number | null;
  effectiveFrom?: Date | null;
}): Override {
  return {
    coachId: "coach-1",
    programId: "program-1",
    payMode: o.payMode,
    ratePer30MinCents: o.ratePer30MinCents ?? null,
    perSessionRateCents: o.perSessionRateCents ?? null,
    // SPEC rate-effective-dating §4: additive column, NOT consulted by the
    // resolvers. Null here = "always been this rate" = today's behavior.
    effectiveFrom: o.effectiveFrom ?? null,
    updatedAt: new Date("2026-07-23T00:00:00Z"),
  };
}

const HOURLY_PROGRAM: ProgramPayConfig = {
  payMode: "hourly",
  defaultRatePer30MinCents: 1500, // $30/hr
  defaultPerSessionRateCents: null,
};
// A flat $100 per game, however long the game runs.
const PER_SESSION_PROGRAM: ProgramPayConfig = {
  payMode: "per_session",
  defaultRatePer30MinCents: 2500, // stale leftover — must NOT be used
  defaultPerSessionRateCents: 10_000,
};

describe("pre-0052 behavior is preserved for hourly programs", () => {
  it("no override → the program's hourly default, no per-session snapshot", () => {
    expect(resolveRateCentsForProgram(null, HOURLY_PROGRAM)).toBe(1500);
    expect(resolvePerSessionRateCents(null, HOURLY_PROGRAM)).toBeNull();
  });

  it("hourly override wins over the program default", () => {
    const o = override({ payMode: "hourly", ratePer30MinCents: 2000 });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM)).toBe(2000);
    expect(resolvePerSessionRateCents(o, HOURLY_PROGRAM)).toBeNull();
  });

  it("per-session override wins, and still falls through to the program's hourly default", () => {
    // Unchanged from before 0052: the hourly snapshot is harmless because
    // workPayForLog prefers the per-session amount. Kept identical so this
    // change re-prices NOTHING on deploy.
    const o = override({ payMode: "per_session", perSessionRateCents: 7500 });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM)).toBe(1500);
    expect(resolvePerSessionRateCents(o, HOURLY_PROGRAM)).toBe(7500);
  });

  it("a program with no rate at all resolves to $0, never a guess", () => {
    const bare: ProgramPayConfig = {
      payMode: "hourly",
      defaultRatePer30MinCents: null,
      defaultPerSessionRateCents: null,
    };
    expect(resolveRateCentsForProgram(null, bare)).toBeNull();
    expect(resolvePerSessionRateCents(null, bare)).toBeNull();
  });
});

describe("0052: program-level per-session pay", () => {
  it("no override → the program's flat per-session amount, and NO hourly basis", () => {
    expect(resolvePerSessionRateCents(null, PER_SESSION_PROGRAM)).toBe(10_000);
    // The stale hourly default must not leak onto the row.
    expect(resolveRateCentsForProgram(null, PER_SESSION_PROGRAM)).toBeNull();
  });

  it("pays the SAME flat amount no matter how long the session ran — the actual bug", () => {
    const perSessionRateCents = resolvePerSessionRateCents(
      null,
      PER_SESSION_PROGRAM,
    );
    const ratePer30MinCents = resolveRateCentsForProgram(
      null,
      PER_SESSION_PROGRAM,
    );
    const pay = (hours: number) =>
      workPayForLog({
        perSessionRateCents,
        ratePer30MinCents,
        startAt: new Date("2026-07-11T17:00:00Z"),
        endAt: new Date(Date.parse("2026-07-11T17:00:00Z") + hours * 3_600_000),
      });

    // A 2-hour game and a 3.5-hour game both pay exactly $100. Under the old
    // hourly fake at $100/hr these paid $200 and $350.
    expect(pay(2)).toBe(10_000);
    expect(pay(3.5)).toBe(10_000);
    expect(pay(9.5)).toBe(10_000);
  });

  it("a per-session program with no amount set pays $0 — loud, not silently hourly", () => {
    const unset: ProgramPayConfig = {
      payMode: "per_session",
      defaultRatePer30MinCents: 2500,
      defaultPerSessionRateCents: null,
    };
    expect(resolvePerSessionRateCents(null, unset)).toBeNull();
    expect(resolveRateCentsForProgram(null, unset)).toBeNull();
  });

  it("rejects a non-positive or non-integer per-session amount", () => {
    for (const bad of [0, -1, 10.5, null]) {
      const p: ProgramPayConfig = {
        payMode: "per_session",
        defaultRatePer30MinCents: null,
        defaultPerSessionRateCents: bad as number | null,
      };
      expect(resolvePerSessionRateCents(null, p)).toBeNull();
    }
  });
});

describe("precedence: a coach override always beats the program default", () => {
  it("an HOURLY override on a PER-SESSION program keeps that coach on the clock", () => {
    // This is the operational trap: flipping a program to per-session does
    // NOT reach coaches holding an hourly override. The Work tab warns.
    const o = override({ payMode: "hourly", ratePer30MinCents: 2500 });
    expect(resolveRateCentsForProgram(o, PER_SESSION_PROGRAM)).toBe(2500);
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM)).toBeNull();

    const pay = workPayForLog({
      perSessionRateCents: resolvePerSessionRateCents(o, PER_SESSION_PROGRAM),
      ratePer30MinCents: resolveRateCentsForProgram(o, PER_SESSION_PROGRAM),
      startAt: new Date("2026-07-11T17:00:00Z"),
      endAt: new Date("2026-07-11T20:30:00Z"), // 3.5h
    });
    expect(pay).toBe(17_500); // 3.5h x $50/hr — NOT the $100 flat fee
  });

  it("a coach's per-session override beats the program's per-session amount", () => {
    const o = override({ payMode: "per_session", perSessionRateCents: 12_500 });
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM)).toBe(12_500);
  });

  it("a per-session override with an INVALID amount does not fall back to the program's amount", () => {
    // Preserves pre-0052 behavior: an unusable override amount yields null
    // rather than silently reaching past the coach's own setting.
    const o = override({ payMode: "per_session", perSessionRateCents: 0 });
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM)).toBeNull();
  });

  it("an hourly override with no rate set falls through to the program", () => {
    const o = override({ payMode: "hourly", ratePer30MinCents: null });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM)).toBe(1500);
  });
});

// SPEC rate-effective-dating §5 — provenance of the stamped snapshot. This is
// INFORMATIONAL ONLY: no pay calculation may ever read it. What these tests
// protect is the one property that makes it trustworthy — the recorded
// provenance must always name the input that ACTUALLY produced the rate on
// the row, across the same branch space the resolvers are tested over.
describe("rateSourceKind provenance (informational, never money)", () => {
  const NO_RATES: ProgramPayConfig = {
    payMode: "hourly",
    defaultRatePer30MinCents: null,
    defaultPerSessionRateCents: null,
  };
  const PER_SESSION_UNSET: ProgramPayConfig = {
    payMode: "per_session",
    defaultRatePer30MinCents: 2500, // stale leftover — never used
    defaultPerSessionRateCents: null,
  };

  describe('"program_default" — the program supplied the rate', () => {
    it("no override, hourly program with a default", () => {
      expect(resolveRateSourceKind(null, HOURLY_PROGRAM)).toBe(
        "program_default",
      );
      // undefined (the shape a missing Drizzle row actually destructures to)
      // must behave identically to null.
      expect(resolveRateSourceKind(undefined, HOURLY_PROGRAM)).toBe(
        "program_default",
      );
    });

    it("no override, per-session program with a flat amount", () => {
      expect(resolveRateSourceKind(null, PER_SESSION_PROGRAM)).toBe(
        "program_default",
      );
    });

    it("an hourly override with NO rate set — the program is what paid", () => {
      // The override row exists but supplied nothing; the rate on the row came
      // from the program, so a program-level retro legitimately owns this log.
      const o = override({ payMode: "hourly", ratePer30MinCents: null });
      expect(resolveRateSourceKind(o, HOURLY_PROGRAM)).toBe("program_default");
    });
  });

  describe('"override" — the (coach, program) override supplied the rate', () => {
    it("hourly override with a rate", () => {
      const o = override({ payMode: "hourly", ratePer30MinCents: 2000 });
      expect(resolveRateSourceKind(o, HOURLY_PROGRAM)).toBe("override");
    });

    it("per-session override with a flat amount", () => {
      const o = override({ payMode: "per_session", perSessionRateCents: 7500 });
      expect(resolveRateSourceKind(o, HOURLY_PROGRAM)).toBe("override");
    });

    it("hourly override on a PER-SESSION program — the coach stays on the clock", () => {
      const o = override({ payMode: "hourly", ratePer30MinCents: 2500 });
      expect(resolveRateSourceKind(o, PER_SESSION_PROGRAM)).toBe("override");
    });

    it("per-session override beats the program's own per-session amount", () => {
      const o = override({
        payMode: "per_session",
        perSessionRateCents: 12_500,
      });
      expect(resolveRateSourceKind(o, PER_SESSION_PROGRAM)).toBe("override");
    });
  });

  describe('"none" — nothing supplied a rate ($0-loud)', () => {
    it("no override and a program with no rate at all", () => {
      expect(resolveRateSourceKind(null, NO_RATES)).toBe("none");
    });

    it("no override and a per-session program with no amount set", () => {
      expect(resolveRateSourceKind(null, PER_SESSION_UNSET)).toBe("none");
    });

    it("a per-session override with an INVALID amount, on a per-session program", () => {
      // The override yields null (invalid amount) and does not reach past
      // itself; the per-session program has no hourly basis. Nobody paid.
      const o = override({ payMode: "per_session", perSessionRateCents: 0 });
      expect(resolveRateSourceKind(o, PER_SESSION_PROGRAM)).toBe("none");
    });

    it("a null program (no pay config at all)", () => {
      expect(resolveRateSourceKind(null, null)).toBe("none");
    });
  });

  it("NEVER disagrees with the rate that was actually stamped", () => {
    // The invariant the column lives or dies by. Sweep the whole
    // (override x program) space and assert: "none" iff both snapshots are
    // null, and otherwise the named source is the one holding that exact
    // number.
    const overrides: Override[] = [
      null,
      undefined,
      override({ payMode: "hourly", ratePer30MinCents: 2000 }),
      override({ payMode: "hourly", ratePer30MinCents: null }),
      override({ payMode: "per_session", perSessionRateCents: 7500 }),
      override({ payMode: "per_session", perSessionRateCents: 0 }),
    ];
    const programs: (ProgramPayConfig | null)[] = [
      HOURLY_PROGRAM,
      PER_SESSION_PROGRAM,
      NO_RATES,
      PER_SESSION_UNSET,
      null,
    ];

    for (const o of overrides) {
      for (const p of programs) {
        const hourly = resolveRateCentsForProgram(o, p);
        const flat = resolvePerSessionRateCents(o, p);
        const kind = resolveRateSourceKind(o, p);
        const where = `override=${JSON.stringify(o)} program=${JSON.stringify(p)}`;

        if (hourly === null && flat === null) {
          expect(kind, where).toBe("none");
          continue;
        }
        expect(kind, where).not.toBe("none");

        // The stamped number, and who is holding it.
        const stamped = flat ?? hourly;
        const fromOverride =
          flat !== null
            ? o?.perSessionRateCents === stamped
            : o?.ratePer30MinCents === stamped;
        const fromProgram =
          flat !== null
            ? p?.defaultPerSessionRateCents === stamped
            : p?.defaultRatePer30MinCents === stamped;

        if (kind === "override") {
          expect(fromOverride, where).toBe(true);
        } else {
          expect(fromProgram, where).toBe(true);
          // A program default can only be the source when the override did
          // not supply that value itself.
          expect(fromOverride, where).toBe(false);
        }
      }
    }
  });
});
