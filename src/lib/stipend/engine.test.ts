// stipend SPEC §6.3 / §12.4 — the stipend WRITE-PATH guards, with literals.
//
// ⚠️ TZ-INDEPENDENT BY CONSTRUCTION, like `pay-period.test.ts`. Period
// boundaries are built with `parsePfaInput` (PFA wall clock), and the handful
// of UTC instants are written as explicit `Z` literals precisely so the
// PFA-vs-UTC divergence is asserted rather than assumed. Nothing reads the
// runtime clock: `now` is a parameter on both planners.
//
// The blocks that matter most if this file ever has to be triaged:
//   · "forward-only" — two overlapping stipend versions is a coach paid twice
//     for one half-month. The append-only shape is the whole defence.
//   · "the §12.4 back-pay guard" — money the app newly claims is owed may
//     already have been settled in cash. The CURRENT period counts as
//     backdated; treating it as safe is the off-by-one that would miss the
//     most likely real mistake.
//   · "a $0 stipend is refused" — the only way this feature can silently pay
//     a coach nothing for real hours.

import { describe, expect, it } from "vitest";
import { parsePfaInput } from "@/lib/timezone";
import {
  planEndStipend,
  planSetStipend,
  StipendPlanError,
  type StipendVersion,
} from "./engine";

/** PFA-midnight on a pay-period boundary. */
function boundary(date: string): Date {
  return parsePfaInput(date, "00:00");
}

/** Aug 20 2026, 11:00 AM PFA — inside 2026-08-P2. */
const NOW = parsePfaInput("2026-08-20", "11:00");

const SEP_1 = boundary("2026-09-01");
const SEP_16 = boundary("2026-09-16");
const OCT_1 = boundary("2026-10-01");
const AUG_1 = boundary("2026-08-01");
const AUG_16 = boundary("2026-08-16");
const JUL_1 = boundary("2026-07-01");

function version(over: Partial<StipendVersion> = {}): StipendVersion {
  return {
    id: "v1",
    amountCents: 250_000,
    effectiveFrom: AUG_16,
    effectiveTo: null,
    ...over,
  };
}

/** Assert a StipendPlanError with a specific code, and return it. */
function expectPlanError(fn: () => unknown, code: string): StipendPlanError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  // Fail loudly naming what was expected — a bare `toThrow()` would pass on
  // ANY error, including a TypeError from a refactor that broke the planner.
  expect(caught, `expected a StipendPlanError(${code}), got nothing`).toBeInstanceOf(
    StipendPlanError,
  );
  const err = caught as StipendPlanError;
  expect(err.code).toBe(code);
  return err;
}

describe("planSetStipend — the amount", () => {
  it("refuses $0 rather than silently paying a covered coach nothing", () => {
    // 🔴 resolveStipendCovered puts a coach on a stipend by the PRESENCE of an
    // amount. A $0 version would zero every covered log's pay and then earn
    // $0 — real hours, no pay, every screen internally consistent.
    const err = expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 0,
          effectiveFrom: SEP_1,
          now: NOW,
        }),
      "AMOUNT_NOT_POSITIVE",
    );
    expect(err.message).toMatch(/end it instead/i);
  });

  it("refuses a negative amount", () => {
    expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: -1,
          effectiveFrom: SEP_1,
          now: NOW,
        }),
      "AMOUNT_NOT_POSITIVE",
    );
  });

  it("refuses fractional cents", () => {
    expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 250_000.5,
          effectiveFrom: SEP_1,
          now: NOW,
        }),
      "AMOUNT_NOT_POSITIVE",
    );
  });

  it("accepts a positive whole-cent amount", () => {
    const plan = planSetStipend({
      existing: [],
      amountCents: 250_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.amountCents).toBe(250_000);
  });
});

describe("planSetStipend — the period boundary (§6.3)", () => {
  it("accepts the 1st and the 16th", () => {
    for (const d of [SEP_1, SEP_16, OCT_1]) {
      expect(() =>
        planSetStipend({
          existing: [],
          amountCents: 250_000,
          effectiveFrom: d,
          now: NOW,
        }),
      ).not.toThrow();
    }
  });

  it("refuses any other calendar day", () => {
    for (const day of ["02", "10", "15", "17", "30"]) {
      expectPlanError(
        () =>
          planSetStipend({
            existing: [],
            amountCents: 250_000,
            effectiveFrom: boundary(`2026-09-${day}`),
            now: NOW,
          }),
        "NOT_PERIOD_START",
      );
    }
  });

  it("refuses a mid-day instant on the 1st — the boundary is midnight, not the date", () => {
    expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 250_000,
          effectiveFrom: parsePfaInput("2026-09-01", "09:00"),
          now: NOW,
        }),
      "NOT_PERIOD_START",
    );
  });

  it("🔴 is PFA-pinned, not UTC-pinned", () => {
    // Midnight UTC on Sept 1 is 5:00 PM PFA on Aug 31 — inside 2026-08-P2, and
    // not a boundary at all. A server-clock boundary would accept this and
    // start the stipend a whole period early. There is a window like this
    // every single day.
    expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 250_000,
          effectiveFrom: new Date("2026-09-01T00:00:00Z"),
          now: NOW,
        }),
      "NOT_PERIOD_START",
    );

    // And the instant that IS the PFA boundary is 07:00Z in September (PDT).
    expect(SEP_1.toISOString()).toBe("2026-09-01T07:00:00.000Z");
    // December is PST — 08:00Z. Hardcoding 07:00 year-round would silently
    // shift every winter period by an hour.
    expect(boundary("2026-12-01").toISOString()).toBe(
      "2026-12-01T08:00:00.000Z",
    );
  });

  it("refuses an invalid date instead of throwing a RangeError", () => {
    expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 250_000,
          effectiveFrom: new Date("not a date"),
          now: NOW,
        }),
      "NOT_PERIOD_START",
    );
  });
});

describe("planSetStipend — forward-only (the no-overlap property)", () => {
  it("closes the open version at exactly the new version's start", () => {
    const open = version({ id: "open", effectiveFrom: AUG_16 });
    const plan = planSetStipend({
      existing: [open],
      amountCents: 300_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.closeRowId).toBe("open");
    // 🔴 The two windows MEET. Anything other than exact equality is either a
    // gap (a period earns nothing) or an overlap (a period earns twice).
    expect(plan.closeAt?.getTime()).toBe(SEP_1.getTime());
  });

  it("has nothing to close for a coach's first stipend", () => {
    const plan = planSetStipend({
      existing: [],
      amountCents: 250_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.closeRowId).toBeNull();
    expect(plan.closeAt).toBeNull();
  });

  it("has nothing to close when every version is already ended", () => {
    const plan = planSetStipend({
      existing: [
        version({ id: "old", effectiveFrom: JUL_1, effectiveTo: AUG_1 }),
      ],
      amountCents: 250_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.closeRowId).toBeNull();
  });

  it("refuses a start in the SAME period as an existing version", () => {
    expectPlanError(
      () =>
        planSetStipend({
          existing: [version({ effectiveFrom: SEP_1 })],
          amountCents: 300_000,
          effectiveFrom: SEP_1,
          now: NOW,
          confirmBackdate: true,
        }),
      "NOT_FORWARD_ONLY",
    );
  });

  it("refuses a start BEFORE an existing version — past periods are never rewritten (Q5)", () => {
    expectPlanError(
      () =>
        planSetStipend({
          existing: [version({ effectiveFrom: SEP_16 })],
          amountCents: 300_000,
          effectiveFrom: SEP_1,
          now: NOW,
          confirmBackdate: true,
        }),
      "NOT_FORWARD_ONLY",
    );
  });

  it("refuses a start inside an already-ENDED version's window", () => {
    // Aug 1 → Oct 1 closed window; a new version starting Sep 1 would overlap
    // it. Unreachable through this planner today, but it is the invariant the
    // money rests on, so it is checked rather than reasoned about.
    expectPlanError(
      () =>
        planSetStipend({
          existing: [
            version({ id: "closed", effectiveFrom: JUL_1, effectiveTo: OCT_1 }),
          ],
          amountCents: 300_000,
          effectiveFrom: SEP_1,
          now: NOW,
        }),
      "NOT_FORWARD_ONLY",
    );
  });

  it("does not depend on the order the existing rows arrive in", () => {
    // The action's SELECT has an ORDER BY today. A future edit to that query
    // must not be able to turn this check into a coin flip.
    const rows = [
      version({ id: "b", effectiveFrom: SEP_16 }),
      version({ id: "a", effectiveFrom: AUG_16, effectiveTo: SEP_16 }),
    ];
    expectPlanError(
      () =>
        planSetStipend({
          existing: rows,
          amountCents: 300_000,
          effectiveFrom: SEP_1,
          now: NOW,
          confirmBackdate: true,
        }),
      "NOT_FORWARD_ONLY",
    );
  });
});

describe("planSetStipend — the §12.4 back-pay guard", () => {
  it("costs nothing for a forward-dated stipend — the normal case", () => {
    const plan = planSetStipend({
      existing: [],
      amountCents: 250_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.backdatedPeriods).toEqual([]);
  });

  it("🔴 treats the CURRENT period as backdated", () => {
    // NOW is Aug 20 — inside 2026-08-P2, which started on the 16th. Hours in
    // it are already logged, so starting the stipend there IS retroactive.
    const err = expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 250_000,
          effectiveFrom: AUG_16,
          now: NOW,
        }),
      "BACKDATE_NOT_CONFIRMED",
    );
    expect(err.backdatedPeriods.map((p) => p.key)).toEqual(["2026-08-P2"]);
  });

  it("names every period from the start date through the current one", () => {
    const err = expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 250_000,
          effectiveFrom: JUL_1,
          now: NOW,
        }),
      "BACKDATE_NOT_CONFIRMED",
    );
    expect(err.backdatedPeriods.map((p) => p.key)).toEqual([
      "2026-07-P1",
      "2026-07-P2",
      "2026-08-P1",
      "2026-08-P2",
    ]);
  });

  it("quotes the money at stake, not just the period count", () => {
    // Read the message as Mark would: a confirmation that does not say what it
    // costs is a confirmation nobody can weigh.
    const err = expectPlanError(
      () =>
        planSetStipend({
          existing: [],
          amountCents: 250_000,
          effectiveFrom: AUG_1,
          now: NOW,
        }),
      "BACKDATE_NOT_CONFIRMED",
    );
    expect(err.backdatedPeriods).toHaveLength(2);
    expect(err.message).toContain("$2500.00"); // per period
    expect(err.message).toContain("$5000.00"); // 2 periods
  });

  it("proceeds once the caller confirms, and still reports what it did", () => {
    const plan = planSetStipend({
      existing: [],
      amountCents: 250_000,
      effectiveFrom: AUG_1,
      now: NOW,
      confirmBackdate: true,
    });
    expect(plan.effectiveFrom.getTime()).toBe(AUG_1.getTime());
    expect(plan.backdatedPeriods.map((p) => p.key)).toEqual([
      "2026-08-P1",
      "2026-08-P2",
    ]);
  });

  it("a start one period in the future is NOT backdated, even hours before it", () => {
    // The boundary of the guard itself: Sept 1 with `now` late on Aug 31 PFA.
    const plan = planSetStipend({
      existing: [],
      amountCents: 250_000,
      effectiveFrom: SEP_1,
      now: parsePfaInput("2026-08-31", "23:59"),
    });
    expect(plan.backdatedPeriods).toEqual([]);
  });
});

describe("planEndStipend", () => {
  it("closes the open version at the given boundary", () => {
    const plan = planEndStipend({
      existing: [version({ id: "open", effectiveFrom: AUG_16 })],
      effectiveTo: OCT_1,
      now: NOW,
    });
    expect(plan.closeRowId).toBe("open");
    expect(plan.closeAt.getTime()).toBe(OCT_1.getTime());
    expect(plan.backdatedPeriods).toEqual([]);
  });

  it("refuses when the coach is not on a stipend", () => {
    expectPlanError(
      () =>
        planEndStipend({
          existing: [
            version({ effectiveFrom: JUL_1, effectiveTo: AUG_1 }),
          ],
          effectiveTo: OCT_1,
          now: NOW,
        }),
      "NO_OPEN_VERSION",
    );
  });

  it("refuses an end date that is not a period boundary", () => {
    expectPlanError(
      () =>
        planEndStipend({
          existing: [version()],
          effectiveTo: parsePfaInput("2026-10-07", "00:00"),
          now: NOW,
        }),
      "NOT_PERIOD_START",
    );
  });

  it("refuses an end at or before the version's own start — an empty window", () => {
    for (const end of [AUG_16, AUG_1]) {
      expectPlanError(
        () =>
          planEndStipend({
            existing: [version({ effectiveFrom: AUG_16 })],
            effectiveTo: end,
            now: NOW,
            confirmBackdate: true,
          }),
        "NOT_FORWARD_ONLY",
      );
    }
  });

  it("🔴 guards a retroactive END too — the pay DECREASE case", () => {
    // The standing handoff rule: never apply a pay decrease without asking
    // Mark what's already been paid. Ending mid-period is that, exactly.
    const err = expectPlanError(
      () =>
        planEndStipend({
          existing: [version({ effectiveFrom: JUL_1 })],
          effectiveTo: AUG_16,
          now: NOW,
        }),
      "BACKDATE_NOT_CONFIRMED",
    );
    expect(err.backdatedPeriods.map((p) => p.key)).toEqual(["2026-08-P2"]);
  });

  it("proceeds on a confirmed retroactive end", () => {
    const plan = planEndStipend({
      existing: [version({ id: "open", effectiveFrom: JUL_1 })],
      effectiveTo: AUG_16,
      now: NOW,
      confirmBackdate: true,
    });
    expect(plan.closeRowId).toBe("open");
    expect(plan.backdatedPeriods).toHaveLength(1);
  });
});
