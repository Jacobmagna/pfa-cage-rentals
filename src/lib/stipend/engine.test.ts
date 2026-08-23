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
  planCancelStipend,
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

  it("refuses a start in the SAME period as a version that has ALREADY STARTED", () => {
    // ⚠️ THE FIXTURE IS THE POINT. This used to use SEP_1 — a FUTURE period,
    // since NOW is Aug 20 — and so it asserted that a stipend set up in
    // advance could never be corrected before it paid. That was the defect,
    // not the guard. AUG_16 is under way at NOW, which is the case the
    // forward-only rule actually exists to refuse.
    expectPlanError(
      () =>
        planSetStipend({
          existing: [version({ effectiveFrom: AUG_16 })],
          amountCents: 300_000,
          effectiveFrom: AUG_16,
          now: NOW,
          confirmBackdate: true,
        }),
      "NOT_FORWARD_ONLY",
    );
  });

  it("🔴 but ALLOWS a re-set of a version whose period has not begun", () => {
    // The other half of the same rule, and the reason the fixture above had to
    // change. A stipend starting Sep 1, corrected on Aug 20, has paid nobody.
    const plan = planSetStipend({
      existing: [version({ id: "typo", effectiveFrom: SEP_1 })],
      amountCents: 300_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.replacedRowIds).toEqual(["typo"]);
    expect(plan.amountCents).toBe(300_000);
  });

  it("refuses a start BEFORE a version that has already started — begun periods are never rewritten (Q5)", () => {
    // Same fixture correction as above: AUG_16 has begun at NOW, so moving a
    // new version to AUG_1 would rewrite a half-month that may already have
    // been logged against.
    expectPlanError(
      () =>
        planSetStipend({
          existing: [version({ effectiveFrom: AUG_16 })],
          amountCents: 300_000,
          effectiveFrom: AUG_1,
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
    // Both rows have STARTED at NOW (Aug 20), so the forward-only rule is in
    // force for them regardless of which order the query hands them over.
    const rows = [
      version({ id: "b", effectiveFrom: AUG_16 }),
      version({ id: "a", effectiveFrom: AUG_1, effectiveTo: AUG_16 }),
    ];
    // AUG_16 is the latest STARTED row, so a new version starting there must
    // be refused whichever order the two rows arrive in.
    expectPlanError(
      () =>
        planSetStipend({
          existing: rows,
          amountCents: 300_000,
          effectiveFrom: AUG_16,
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
    // 🔴 Thousands separators, matching `formatDollarsExact` — the formatter
    // the card's current-amount line and history table already use. `toFixed`
    // printed "$2500.00" next to "$2,500.00" on the same screen.
    expect(err.message).toContain("$2,500.00"); // per period
    expect(err.message).toContain("$5,000.00"); // 2 periods
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

// ─────────────────────────────────────────────────────────────────────────
// 🔴 A STIPEND THAT HAS NOT STARTED IS FULLY REVERSIBLE
//
// The whole block exists because it used to be the opposite. A stipend set up
// in August for a September start could not be corrected (forward-only refused
// a re-set of the same period) and could not be cancelled (the end guard
// refused to close a window that had not opened), so the earliest reachable
// removal was the FOLLOWING period — by which point a covered log had earned
// it, and there is no void UI. That made "wrong coach" and "wrong amount"
// unrecoverable on the exact path everyone walks during the Sept 1 rollout.
// ─────────────────────────────────────────────────────────────────────────
describe("correcting a stipend that has not started yet", () => {
  it("REPLACES a not-yet-started version at the same pay period", () => {
    const plan = planSetStipend({
      existing: [
        { id: "typo", amountCents: 900_000, effectiveFrom: SEP_1, effectiveTo: null },
      ],
      amountCents: 250_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.replacedRowIds).toEqual(["typo"]);
    expect(plan.amountCents).toBe(250_000);
    expect(plan.effectiveFrom).toEqual(SEP_1);
    // Nothing to close — the row it displaces is being deleted, not bounded.
    expect(plan.closeRowId).toBeNull();
    expect(plan.backdatedPeriods).toHaveLength(0);
  });

  it("🔴 does NOT replace a future version at a DIFFERENT period — that is a scheduled change", () => {
    // The guard on the guard. Mark setting $2,500 from Sep 1 and then $3,000
    // from Sep 16 is a legitimate two-step plan. A replacement rule keyed on
    // "not started yet" alone would DELETE the September 1 row when the
    // September 16 one was saved — trading the bug this fixes for a worse,
    // quieter one.
    const plan = planSetStipend({
      existing: [
        { id: "sep1", amountCents: 250_000, effectiveFrom: SEP_1, effectiveTo: null },
      ],
      amountCents: 300_000,
      effectiveFrom: SEP_16,
      now: NOW,
    });
    expect(plan.replacedRowIds).toEqual([]);
    // Closed off in the normal forward-only way, so the two windows MEET.
    expect(plan.closeRowId).toBe("sep1");
    expect(plan.closeAt).toEqual(SEP_16);
  });

  it("MOVES the previous version's boundary when a same-period typo is replaced", () => {
    // Aug is live and was closed off at Sep 1 to make room for the typo. The
    // replacement also starts Sep 1, so August's boundary stays at Sep 1 —
    // but it must be RE-STAMPED, because the row that created that boundary
    // is being deleted.
    const plan = planSetStipend({
      existing: [
        { id: "aug", amountCents: 200_000, effectiveFrom: AUG_1, effectiveTo: SEP_1 },
        { id: "typo", amountCents: 900_000, effectiveFrom: SEP_1, effectiveTo: null },
      ],
      amountCents: 250_000,
      effectiveFrom: SEP_1,
      now: NOW,
    });
    expect(plan.replacedRowIds).toEqual(["typo"]);
    expect(plan.closeRowId).toBe("aug");
    expect(plan.closeAt).toEqual(SEP_1);
  });

  it("🔴 STILL refuses to rewrite a period that has already begun", () => {
    // The guard this feature actually rests on. Aug 16–31 is under way at NOW.
    expect(() =>
      planSetStipend({
        existing: [
          { id: "live", amountCents: 250_000, effectiveFrom: AUG_16, effectiveTo: null },
        ],
        amountCents: 300_000,
        effectiveFrom: AUG_16,
        now: NOW,
      }),
    ).toThrow(StipendPlanError);
  });

  it("says 'already begun', never 'past periods', about a FUTURE period", () => {
    // The old message justified the refusal with "past periods are never
    // rewritten" — about a period eleven days in the future. A correct-sounding
    // reason attached to the wrong situation is worse than no reason.
    let message = "";
    try {
      planSetStipend({
        existing: [
          { id: "live", amountCents: 250_000, effectiveFrom: AUG_16, effectiveTo: null },
        ],
        amountCents: 300_000,
        effectiveFrom: AUG_16,
        now: NOW,
      });
    } catch (err) {
      message = (err as StipendPlanError).message;
    }
    expect(message).toMatch(/already started/i);
    expect(message).not.toMatch(/past periods are never rewritten/i);
  });
});

describe("planCancelStipend", () => {
  it("deletes a not-yet-started version outright", () => {
    const plan = planCancelStipend({
      existing: [
        { id: "oops", amountCents: 250_000, effectiveFrom: SEP_1, effectiveTo: null },
      ],
      now: NOW,
    });
    expect(plan.deleteRowIds).toEqual(["oops"]);
    expect(plan.reopenRowId).toBeNull();
  });

  it("🔴 REOPENS whatever the cancelled version displaced", () => {
    // Without this, cancelling a September change leaves August closed off at
    // a boundary that no longer exists — the coach on NO stipend at all, a
    // silent pay cut produced by an undo.
    const plan = planCancelStipend({
      existing: [
        { id: "aug", amountCents: 200_000, effectiveFrom: AUG_1, effectiveTo: SEP_1 },
        { id: "oops", amountCents: 900_000, effectiveFrom: SEP_1, effectiveTo: null },
      ],
      now: NOW,
    });
    expect(plan.deleteRowIds).toEqual(["oops"]);
    expect(plan.reopenRowId).toBe("aug");
  });

  it("does NOT reopen a version that someone explicitly ended", () => {
    // Aug was ended at Aug 16 on purpose; Sep was set up separately. Cancelling
    // Sep must not resurrect August's coverage.
    const plan = planCancelStipend({
      existing: [
        { id: "aug", amountCents: 200_000, effectiveFrom: AUG_1, effectiveTo: AUG_16 },
        { id: "sep", amountCents: 250_000, effectiveFrom: SEP_1, effectiveTo: null },
      ],
      now: NOW,
    });
    expect(plan.deleteRowIds).toEqual(["sep"]);
    expect(plan.reopenRowId).toBeNull();
  });

  it("refuses to cancel a stipend that has already started, and says what to do instead", () => {
    let err: StipendPlanError | null = null;
    try {
      planCancelStipend({
        existing: [
          { id: "live", amountCents: 250_000, effectiveFrom: AUG_16, effectiveTo: null },
        ],
        now: NOW,
      });
    } catch (e) {
      err = e as StipendPlanError;
    }
    expect(err?.code).toBe("ALREADY_STARTED");
    expect(err?.message).toMatch(/end it from a future pay period/i);
  });

  it("refuses when the coach is not on a stipend at all", () => {
    let err: StipendPlanError | null = null;
    try {
      planCancelStipend({ existing: [], now: NOW });
    } catch (e) {
      err = e as StipendPlanError;
    }
    expect(err?.code).toBe("NO_OPEN_VERSION");
  });
});

describe("the words the admin actually reads", () => {
  it("🔴 formats money the same way the rest of the card does", () => {
    // `toFixed(2)` printed "$2500.00" inside the back-pay panel while the
    // card header and history table printed "$2,500.00" — two formats for one
    // number, on one screen, inside the most important warning in the feature.
    let message = "";
    try {
      planSetStipend({
        existing: [],
        amountCents: 250_000,
        effectiveFrom: AUG_16,
        now: NOW,
      });
    } catch (err) {
      message = (err as StipendPlanError).message;
    }
    expect(message).toContain("$2,500.00");
    expect(message).not.toContain("$2500.00");
  });

  it("does not quote the same figure twice when only ONE period is affected", () => {
    // "owed $2,500.00 per period — up to $2,500.00" read as broken arithmetic.
    let message = "";
    try {
      planSetStipend({
        existing: [],
        amountCents: 250_000,
        effectiveFrom: AUG_16,
        now: NOW,
      });
    } catch (err) {
      message = (err as StipendPlanError).message;
    }
    expect(message).not.toMatch(/per period/);
    expect(message).toMatch(/becomes owed \$2,500\.00 for work/);
  });

  it("🔴 never names a form field at the admin", () => {
    // "Re-submit with confirmBackdate to apply it." named a form field to a
    // non-technical admin, and pointed away from the confirm button sitting
    // directly beneath the sentence.
    const messages: string[] = [];
    for (const attempt of [
      () => planSetStipend({ existing: [], amountCents: 250_000, effectiveFrom: AUG_16, now: NOW }),
      () =>
        planEndStipend({
          existing: [
            { id: "open", amountCents: 250_000, effectiveFrom: AUG_1, effectiveTo: null },
          ],
          effectiveTo: AUG_16,
          now: NOW,
        }),
    ]) {
      try {
        attempt();
      } catch (err) {
        messages.push((err as StipendPlanError).message);
      }
    }
    expect(messages).toHaveLength(2);
    for (const m of messages) expect(m).not.toMatch(/confirmBackdate/);
  });
});
