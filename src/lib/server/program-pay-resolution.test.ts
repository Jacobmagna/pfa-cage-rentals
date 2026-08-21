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
  resolveStipendCovered,
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
  stipendEligible: false,
};
// A flat $100 per game, however long the game runs.
const PER_SESSION_PROGRAM: ProgramPayConfig = {
  payMode: "per_session",
  defaultRatePer30MinCents: 2500, // stale leftover — must NOT be used
  defaultPerSessionRateCents: 10_000,
  stipendEligible: false,
};

describe("pre-0052 behavior is preserved for hourly programs", () => {
  it("no override → the program's hourly default, no per-session snapshot", () => {
    expect(resolveRateCentsForProgram(null, HOURLY_PROGRAM, false)).toBe(1500);
    expect(resolvePerSessionRateCents(null, HOURLY_PROGRAM, false)).toBeNull();
  });

  it("hourly override wins over the program default", () => {
    const o = override({ payMode: "hourly", ratePer30MinCents: 2000 });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM, false)).toBe(2000);
    expect(resolvePerSessionRateCents(o, HOURLY_PROGRAM, false)).toBeNull();
  });

  it("per-session override wins, and still falls through to the program's hourly default", () => {
    // Unchanged from before 0052: the hourly snapshot is harmless because
    // workPayForLog prefers the per-session amount. Kept identical so this
    // change re-prices NOTHING on deploy.
    const o = override({ payMode: "per_session", perSessionRateCents: 7500 });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM, false)).toBe(1500);
    expect(resolvePerSessionRateCents(o, HOURLY_PROGRAM, false)).toBe(7500);
  });

  it("a program with no rate at all resolves to $0, never a guess", () => {
    const bare: ProgramPayConfig = {
      payMode: "hourly",
      defaultRatePer30MinCents: null,
      defaultPerSessionRateCents: null,
      stipendEligible: false,
    };
    expect(resolveRateCentsForProgram(null, bare, false)).toBeNull();
    expect(resolvePerSessionRateCents(null, bare, false)).toBeNull();
  });
});

describe("0052: program-level per-session pay", () => {
  it("no override → the program's flat per-session amount, and NO hourly basis", () => {
    expect(resolvePerSessionRateCents(null, PER_SESSION_PROGRAM, false)).toBe(10_000);
    // The stale hourly default must not leak onto the row.
    expect(resolveRateCentsForProgram(null, PER_SESSION_PROGRAM, false)).toBeNull();
  });

  it("pays the SAME flat amount no matter how long the session ran — the actual bug", () => {
    const perSessionRateCents = resolvePerSessionRateCents(
      null,
      PER_SESSION_PROGRAM,
      false,
    );
    const ratePer30MinCents = resolveRateCentsForProgram(
      null,
      PER_SESSION_PROGRAM,
      false,
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
      stipendEligible: false,
    };
    expect(resolvePerSessionRateCents(null, unset, false)).toBeNull();
    expect(resolveRateCentsForProgram(null, unset, false)).toBeNull();
  });

  it("rejects a non-positive or non-integer per-session amount", () => {
    for (const bad of [0, -1, 10.5, null]) {
      const p: ProgramPayConfig = {
        payMode: "per_session",
        defaultRatePer30MinCents: null,
        defaultPerSessionRateCents: bad as number | null,
        stipendEligible: false,
      };
      expect(resolvePerSessionRateCents(null, p, false)).toBeNull();
    }
  });
});

describe("precedence: a coach override always beats the program default", () => {
  it("an HOURLY override on a PER-SESSION program keeps that coach on the clock", () => {
    // This is the operational trap: flipping a program to per-session does
    // NOT reach coaches holding an hourly override. The Work tab warns.
    const o = override({ payMode: "hourly", ratePer30MinCents: 2500 });
    expect(resolveRateCentsForProgram(o, PER_SESSION_PROGRAM, false)).toBe(2500);
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM, false)).toBeNull();

    const pay = workPayForLog({
      perSessionRateCents: resolvePerSessionRateCents(o, PER_SESSION_PROGRAM, false),
      ratePer30MinCents: resolveRateCentsForProgram(o, PER_SESSION_PROGRAM, false),
      startAt: new Date("2026-07-11T17:00:00Z"),
      endAt: new Date("2026-07-11T20:30:00Z"), // 3.5h
    });
    expect(pay).toBe(17_500); // 3.5h x $50/hr — NOT the $100 flat fee
  });

  it("a coach's per-session override beats the program's per-session amount", () => {
    const o = override({ payMode: "per_session", perSessionRateCents: 12_500 });
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM, false)).toBe(12_500);
  });

  it("a per-session override with an INVALID amount does not fall back to the program's amount", () => {
    // Preserves pre-0052 behavior: an unusable override amount yields null
    // rather than silently reaching past the coach's own setting.
    const o = override({ payMode: "per_session", perSessionRateCents: 0 });
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM, false)).toBeNull();
  });

  it("an hourly override with no rate set falls through to the program", () => {
    const o = override({ payMode: "hourly", ratePer30MinCents: null });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM, false)).toBe(1500);
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
    stipendEligible: false,
  };
  const PER_SESSION_UNSET: ProgramPayConfig = {
    payMode: "per_session",
    defaultRatePer30MinCents: 2500, // stale leftover — never used
    defaultPerSessionRateCents: null,
    stipendEligible: false,
  };

  describe('"program_default" — the program supplied the rate', () => {
    it("no override, hourly program with a default", () => {
      expect(resolveRateSourceKind(null, HOURLY_PROGRAM, false)).toBe(
        "program_default",
      );
      // undefined (the shape a missing Drizzle row actually destructures to)
      // must behave identically to null.
      expect(resolveRateSourceKind(undefined, HOURLY_PROGRAM, false)).toBe(
        "program_default",
      );
    });

    it("no override, per-session program with a flat amount", () => {
      expect(resolveRateSourceKind(null, PER_SESSION_PROGRAM, false)).toBe(
        "program_default",
      );
    });

    it("an hourly override with NO rate set — the program is what paid", () => {
      // The override row exists but supplied nothing; the rate on the row came
      // from the program, so a program-level retro legitimately owns this log.
      const o = override({ payMode: "hourly", ratePer30MinCents: null });
      expect(resolveRateSourceKind(o, HOURLY_PROGRAM, false)).toBe("program_default");
    });
  });

  describe('"override" — the (coach, program) override supplied the rate', () => {
    it("hourly override with a rate", () => {
      const o = override({ payMode: "hourly", ratePer30MinCents: 2000 });
      expect(resolveRateSourceKind(o, HOURLY_PROGRAM, false)).toBe("override");
    });

    it("per-session override with a flat amount", () => {
      const o = override({ payMode: "per_session", perSessionRateCents: 7500 });
      expect(resolveRateSourceKind(o, HOURLY_PROGRAM, false)).toBe("override");
    });

    it("hourly override on a PER-SESSION program — the coach stays on the clock", () => {
      const o = override({ payMode: "hourly", ratePer30MinCents: 2500 });
      expect(resolveRateSourceKind(o, PER_SESSION_PROGRAM, false)).toBe("override");
    });

    it("per-session override beats the program's own per-session amount", () => {
      const o = override({
        payMode: "per_session",
        perSessionRateCents: 12_500,
      });
      expect(resolveRateSourceKind(o, PER_SESSION_PROGRAM, false)).toBe("override");
    });
  });

  describe('"none" — nothing supplied a rate ($0-loud)', () => {
    it("no override and a program with no rate at all", () => {
      expect(resolveRateSourceKind(null, NO_RATES, false)).toBe("none");
    });

    it("no override and a per-session program with no amount set", () => {
      expect(resolveRateSourceKind(null, PER_SESSION_UNSET, false)).toBe("none");
    });

    it("a per-session override with an INVALID amount, on a per-session program", () => {
      // The override yields null (invalid amount) and does not reach past
      // itself; the per-session program has no hourly basis. Nobody paid.
      const o = override({ payMode: "per_session", perSessionRateCents: 0 });
      expect(resolveRateSourceKind(o, PER_SESSION_PROGRAM, false)).toBe("none");
    });

    it("a null program (no pay config at all)", () => {
      expect(resolveRateSourceKind(null, null, false)).toBe("none");
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
        const hourly = resolveRateCentsForProgram(o, p, false);
        const flat = resolvePerSessionRateCents(o, p, false);
        const kind = resolveRateSourceKind(o, p, false);
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


// ─────────────────────────────────────────────────────────────────────────────
// STIPEND SPEC §2.11 — THE DOUBLE-PAY LANDMINE.
//
// A stipend-covered log must stamp NO rate. `resolveRateCentsForProgram` ends
// in `return program?.defaultRatePer30MinCents ?? null`, so a covered log that
// merely failed the override branch lands on the PROGRAM DEFAULT and is paid
// hourly — on top of the stipend that already paid for it. Nothing else in the
// system would notice: the rate is a real configured number and the hours are
// correct.
//
// 🔴 EVERY PROGRAM FIXTURE BELOW CARRIES A NON-ZERO DEFAULT RATE ON PURPOSE.
// That rate is the fall-through's ammunition. A covered-log test against a
// program with no rate set would pass whether or not the guard exists — the
// exact "agrees by coincidence" trap that shipped two meaningless green tests
// during the statement build.
// ─────────────────────────────────────────────────────────────────────────────

/** Stipend-eligible AND carrying a real hourly default. */
const STIPEND_HOURLY_PROGRAM: ProgramPayConfig = {
  payMode: "hourly",
  defaultRatePer30MinCents: 1500, // $30/hr — must NEVER be stamped when covered
  defaultPerSessionRateCents: null,
  stipendEligible: true,
};

/** Stipend-eligible AND carrying a real per-session default. */
const STIPEND_PER_SESSION_PROGRAM: ProgramPayConfig = {
  payMode: "per_session",
  defaultRatePer30MinCents: 2500,
  defaultPerSessionRateCents: 10_000, // $100/session — must NEVER be stamped
  stipendEligible: true,
};

describe("T10 — a covered log stamps NO rate, on a program that HAS one", () => {
  it("does not fall through to the program's hourly default", () => {
    expect(resolveRateCentsForProgram(null, STIPEND_HOURLY_PROGRAM, true)).toBeNull();
    // Control: the identical call, uncovered, DOES stamp the rate. Without
    // this line the assertion above could pass against a broken fixture.
    expect(resolveRateCentsForProgram(null, STIPEND_HOURLY_PROGRAM, false)).toBe(1500);
  });

  it("does not fall through to the program's PER-SESSION default", () => {
    expect(
      resolvePerSessionRateCents(null, STIPEND_PER_SESSION_PROGRAM, true),
    ).toBeNull();
    expect(
      resolvePerSessionRateCents(null, STIPEND_PER_SESSION_PROGRAM, false),
    ).toBe(10_000);
  });

  it("🔴 beats the coach's OWN hourly override — coverage is not a fallback", () => {
    // The override branch normally wins outright. Coverage must run FIRST:
    // a stipend coach who also holds a stale hourly override on the covered
    // program would otherwise be paid by the clock on top of the stipend.
    const own = override({ payMode: "hourly", ratePer30MinCents: 9999 });
    expect(resolveRateCentsForProgram(own, STIPEND_HOURLY_PROGRAM, true)).toBeNull();
    expect(resolveRateCentsForProgram(own, STIPEND_HOURLY_PROGRAM, false)).toBe(9999);
  });

  it("🔴 beats the coach's own PER-SESSION override", () => {
    const own = override({ payMode: "per_session", perSessionRateCents: 7500 });
    expect(
      resolvePerSessionRateCents(own, STIPEND_PER_SESSION_PROGRAM, true),
    ).toBeNull();
    expect(
      resolvePerSessionRateCents(own, STIPEND_PER_SESSION_PROGRAM, false),
    ).toBe(7500);
  });

  it("records provenance as 'none' — nothing supplied a rate, which is true", () => {
    // The rate_source_kind enum is deliberately NOT widened (no ALTER TYPE).
    // hour_logs.stipend_covered is what tells "covered" apart from "unset".
    expect(resolveRateSourceKind(null, STIPEND_HOURLY_PROGRAM, true)).toBe("none");
    expect(
      resolveRateSourceKind(
        override({ payMode: "hourly", ratePer30MinCents: 9999 }),
        STIPEND_HOURLY_PROGRAM,
        true,
      ),
    ).toBe("none");
  });

  it("pays exactly $0 end to end, for any duration", () => {
    const covered = {
      ratePer30MinCents: resolveRateCentsForProgram(null, STIPEND_HOURLY_PROGRAM, true),
      perSessionRateCents: resolvePerSessionRateCents(null, STIPEND_HOURLY_PROGRAM, true),
    };
    const pay = (hours: number) =>
      workPayForLog({
        ...covered,
        startAt: new Date("2026-09-02T17:00:00Z"),
        endAt: new Date(Date.parse("2026-09-02T17:00:00Z") + hours * 3_600_000),
      });
    expect(pay(1)).toBe(0);
    expect(pay(8)).toBe(0);
    // 72 hours in a period is Mark's own example. Still $0 — the stipend is
    // the pay, and the HOURS remain visible everywhere else.
    expect(pay(72)).toBe(0);
  });

  it("leaves an UNCOVERED coach on the SAME program completely unaffected", () => {
    // §2.16a — the fill-in coach who is not on a stipend. This is the control
    // that proves coverage is per (program AND coach), not per program alone.
    expect(resolveRateCentsForProgram(null, STIPEND_HOURLY_PROGRAM, false)).toBe(1500);
    expect(resolveRateSourceKind(null, STIPEND_HOURLY_PROGRAM, false)).toBe(
      "program_default",
    );
  });
});

describe("resolveStipendCovered — BOTH halves are required", () => {
  const eligible = { stipendEligible: true };
  const notEligible = { stipendEligible: false };

  it("covers only when the program is eligible AND the coach has an amount", () => {
    expect(resolveStipendCovered(eligible, 250_000)).toBe(true);
  });

  it("🔴 does NOT cover an eligible program for a coach with no stipend (§2.16a)", () => {
    // The fill-in coach. Without this, a regular hourly coach who covers one
    // softball session would be paid $0 and nothing would flag it.
    expect(resolveStipendCovered(eligible, null)).toBe(false);
  });

  it("does NOT cover a non-eligible program even for a stipend coach", () => {
    // Nick's weightlifting: paid hourly, ON TOP of the stipend.
    expect(resolveStipendCovered(notEligible, 250_000)).toBe(false);
  });

  it("does not cover when there is no program at all", () => {
    expect(resolveStipendCovered(null, 250_000)).toBe(false);
  });

  it("treats a ZERO amount as on-a-stipend, not as absent", () => {
    // A deliberate $0 stipend is a decision an admin can make; `null` is the
    // absence of one. Conflating them would pay a $0-stipend coach hourly.
    expect(resolveStipendCovered(eligible, 0)).toBe(true);
  });
});
