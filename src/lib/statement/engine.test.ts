// payment-statement SPEC §5, §7, §12 — the statement engine's arithmetic.
//
// This is a MONEY DOCUMENT that may be printed and handed to the person it is
// about, so the bar here is `0054`'s, not `40bf31c`'s: every figure is asserted,
// the two tie-out identities are computed a SECOND, independent way in this file
// rather than read back out of the engine, and the boundary cases are the
// month-boundary ones because Alex Milone's real case IS a month boundary.
//
// 🔴 The three deliberate breakages from SPEC §12.8 were each restored and
// confirmed RED before this file was considered done:
//   1. bucket payments by `paidAt` instead of `coversThrough`
//      → the month-boundary + Alex tests go red
//   2. let a NULL `coversThrough` fall into the current period
//      → the unapplied tests go red
//   3. sum the two accounts into one total
//      → the direction-routing test goes red
//
// ⚠️ Runs under `TZ=Asia/Tokyo` and `TZ=America/New_York` as well as the
// developer's own clock (SPEC §12.6). Every instant in this file is built with
// `parsePfaInput` and every period with the real `normalizeFilters`, so the test
// asserts the engine against the same boundary values production hands it —
// not against a hand-rolled UTC approximation that happens to agree in PT.

import { describe, expect, it } from "vitest";
import { netCoachLedgers, type LedgerPayment } from "@/lib/payment-ledger";
import { aggregateReport, type AggregateSessionInput } from "@/lib/reports/aggregate";
import { normalizeFilters } from "@/lib/reports/filters";
import { buildWorkReport } from "@/lib/reports/work-report";
import type { HourLogFetchRow } from "@/lib/reports/hour-log-fetch";
import type { PaymentDirection } from "@/lib/schemas/payment";
import { formatPfaTime12h, parsePfaInput } from "@/lib/timezone";
import {
  buildStatement,
  buildStatementPair,
  buildStatementRoster,
  chargesFromCageDetail,
  chargesFromWorkDetail,
  type StatementChargeInput,
  type StatementPaymentInput,
  type StatementPeriod,
} from "./engine";

/* ── Fixtures + helpers ──────────────────────────────────────────────────── */

/** The two periods the whole feature turns on: Alex paid in August for July. */
const JULY = period("2026-07-01", "2026-07-31");
const AUGUST = period("2026-08-01", "2026-08-31");
const JUNE = period("2026-06-01", "2026-06-30");

/** Through the REAL filter parser, so the boundaries are production's. */
function period(from: string, to: string): StatementPeriod {
  return normalizeFilters({ from, to });
}

/** A PFA wall-clock instant. */
function at(date: string, time = "00:00"): Date {
  return parsePfaInput(date, time);
}

function charge(
  date: string,
  amountCents: number,
  over: Partial<StatementChargeInput> = {},
): StatementChargeInput {
  return {
    startAt: at(date, "09:00"),
    endAt: at(date, "11:00"),
    lineLabel: "Cage",
    description: "Cage 2",
    rateLabel: "$44.00/hr",
    slots: 4,
    hours: 2,
    amountCents,
    ...over,
  };
}

function payment(
  over: Partial<StatementPaymentInput> = {},
): StatementPaymentInput {
  return {
    amountCents: 0,
    direction: "coach_to_pfa",
    status: "confirmed",
    deletedAt: null,
    paidAt: at("2026-08-07", "12:00"),
    coversThrough: null,
    method: "zelle",
    reference: null,
    ...over,
  };
}

/**
 * INDEPENDENT re-implementation of the right-hand side of the SPEC §5.2
 * identity: the balance computed from scratch as of an instant, rather than by
 * walking forward from an opening balance. Written out longhand here on purpose
 * — if it called into the engine it would be asserting that the engine agrees
 * with itself, which is not the property that matters.
 */
function balanceAsOf(
  charges: readonly StatementChargeInput[],
  payments: readonly StatementPaymentInput[],
  direction: PaymentDirection,
  asOfExclusive: Date,
): number {
  const cutoff = asOfExclusive.getTime();
  let owed = 0;
  for (const c of charges) {
    if (c.startAt.getTime() < cutoff) owed += c.amountCents;
  }
  let paid = 0;
  for (const p of payments) {
    if (p.deletedAt != null) continue;
    if (p.status !== "confirmed") continue;
    if (p.direction !== direction) continue;
    if (p.coversThrough == null) continue;
    if (p.coversThrough.getTime() < cutoff) paid += p.amountCents;
  }
  return owed - paid;
}

/** The rows `netCoachLedgers` is contracted to receive, built independently. */
function confirmedLedgerRows(
  payments: readonly StatementPaymentInput[],
): LedgerPayment[] {
  return payments
    .filter((p) => p.deletedAt == null && p.status === "confirmed")
    .map((p) => ({ amountCents: p.amountCents, direction: p.direction }));
}

function sum(charges: readonly StatementChargeInput[]): number {
  return charges.reduce((n, c) => n + c.amountCents, 0);
}

/* ── §1 — Alex Milone's real case. This pair IS the feature. ─────────────── */

describe("Alex Milone: $660 owed for July, Zelled Aug 7, covers through Jul 31", () => {
  const charges = [
    charge("2026-07-02", 22_000),
    charge("2026-07-14", 22_000),
    charge("2026-07-28", 22_000),
  ];
  const payments = [
    payment({
      amountCents: 66_000,
      paidAt: at("2026-08-07", "12:00"),
      coversThrough: at("2026-07-31"),
      reference: "July 2026",
    }),
  ];

  it("viewed from the JULY statement he is SQUARE — $0.00 closing", () => {
    const july = buildStatement({
      account: "cage",
      coachName: "Alex Milone",
      period: JULY,
      charges,
      payments,
    });

    expect(july.openingCents).toBe(0);
    expect(july.chargesCents).toBe(66_000);
    expect(july.paymentsCents).toBe(66_000);
    expect(july.closingCents).toBe(0);
    // The covers-through column is the whole point; it is never hidden.
    expect(july.paymentRows).toEqual([
      {
        paidOn: "Aug 07",
        method: "Zelle",
        reference: "July 2026",
        coversThrough: "Jul 31",
        amountCents: 66_000,
        pending: false,
      },
    ]);
  });

  it("viewed from AUGUST there is NO phantom credit — every figure is zero", () => {
    const august = buildStatement({
      account: "cage",
      coachName: "Alex Milone",
      period: AUGUST,
      charges,
      payments,
    });

    // Bucketing by `paidAt` would put the $660 here, producing a −$660
    // "credit" in August while July still read $660 outstanding.
    expect(august.openingCents).toBe(0);
    expect(august.chargesCents).toBe(0);
    expect(august.paymentsCents).toBe(0);
    expect(august.closingCents).toBe(0);
    expect(august.paymentRows).toEqual([]);
    expect(august.paymentsCoveringAfterCents).toBe(0);
  });

  it("July's opening balance carries nothing from June, and June closes at $0", () => {
    const june = buildStatement({
      account: "cage",
      coachName: "Alex Milone",
      period: JUNE,
      charges,
      payments,
    });
    expect(june.closingCents).toBe(0);
    expect(june.chargesAfterCents).toBe(66_000);
    expect(june.paymentsCoveringAfterCents).toBe(66_000);
  });
});

/* ── §12.6 — MONTH BOUNDARIES. The primary failure mode. ────────────────── */

describe("month boundaries (SPEC §12.6)", () => {
  const charges = [charge("2026-07-15", 10_000)];

  function july(payments: StatementPaymentInput[]) {
    return buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges,
      payments,
    });
  }

  it("coversThrough EXACTLY at fromDate lands IN the period", () => {
    const p = [payment({ amountCents: 500, coversThrough: JULY.fromDate })];
    expect(july(p).paymentsCents).toBe(500);
    expect(july(p).openingCents).toBe(0);
  });

  it("coversThrough at fromDate − 1ms lands BEFORE the period", () => {
    const p = [
      payment({
        amountCents: 500,
        coversThrough: new Date(JULY.fromDate.getTime() - 1),
      }),
    ];
    expect(july(p).paymentsCents).toBe(0);
    expect(july(p).openingCents).toBe(-500);
  });

  it("coversThrough at toDateExclusive − 1ms lands IN the period", () => {
    const p = [
      payment({
        amountCents: 500,
        coversThrough: new Date(JULY.toDateExclusive.getTime() - 1),
      }),
    ];
    expect(july(p).paymentsCents).toBe(500);
    expect(july(p).paymentsCoveringAfterCents).toBe(0);
  });

  it("🔴 coversThrough EXACTLY at toDateExclusive lands in the NEXT period, not this one", () => {
    const p = [
      payment({
        amountCents: 500,
        // 🔴 `paidAt` INSIDE July on purpose. With the default August paid date
        // this assertion passed even with the engine bucketing by `paidAt` —
        // coversThrough Aug 1 and paidAt Aug 7 land in the same month, so the
        // bug was invisible here. A prepayment that arrives in July and covers
        // through Aug 1 is the case that can only be got right one way.
        paidAt: at("2026-07-05", "12:00"),
        coversThrough: JULY.toDateExclusive,
      }),
    ];
    const j = july(p);
    expect(j.paymentsCents).toBe(0);
    expect(j.paymentRows).toEqual([]);
    expect(j.paymentsCoveringAfterCents).toBe(500);

    // …and it IS in August, which is the other half of the same assertion.
    const a = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: AUGUST,
      charges,
      payments: p,
    });
    expect(a.paymentsCents).toBe(500);
  });

  it("ONE payment covering Jul 31, seen from BOTH statements", () => {
    const payments = [
      payment({
        amountCents: 66_000,
        paidAt: at("2026-08-07", "12:00"),
        coversThrough: at("2026-07-31"),
      }),
    ];
    const chargesJulyOnly = [charge("2026-07-02", 66_000)];

    const j = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: chargesJulyOnly,
      payments,
    });
    const a = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: AUGUST,
      charges: chargesJulyOnly,
      payments,
    });

    // July: charged and settled inside the period.
    expect([j.openingCents, j.chargesCents, j.paymentsCents, j.closingCents]).toEqual([
      0, 66_000, 66_000, 0,
    ]);
    // August: the charge is in the OPENING balance (before the period), the
    // payment is in the opening balance too, and nothing lands in-period.
    expect([a.openingCents, a.chargesCents, a.paymentsCents, a.closingCents]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("a charge at toDateExclusive is AFTER the period; at toDateExclusive − 1ms it is IN", () => {
    const boundary = [
      charge("2026-07-15", 100),
      { ...charge("2026-08-01", 200), startAt: JULY.toDateExclusive },
      {
        ...charge("2026-07-31", 300),
        startAt: new Date(JULY.toDateExclusive.getTime() - 1),
      },
    ];
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: boundary,
      payments: [],
    });
    expect(s.chargesCents).toBe(400);
    expect(s.chargesAfterCents).toBe(200);
  });

  it("a charge exactly at fromDate is IN the period, not before it", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: [{ ...charge("2026-07-01", 700), startAt: JULY.fromDate }],
      payments: [],
    });
    expect(s.chargesCents).toBe(700);
    expect(s.openingCents).toBe(0);
  });
});

/* ── §7 — Unapplied. A payment we cannot place is in NO period. ─────────── */

describe("unapplied payments (coversThrough IS NULL)", () => {
  const charges = [charge("2026-07-10", 30_000)];
  const payments = [
    payment({ amountCents: 17_000, coversThrough: null }),
    payment({ amountCents: 30_000, coversThrough: at("2026-07-31") }),
  ];

  it("appears in NO period — not opening, not payments, not closing", () => {
    for (const p of [JUNE, JULY, AUGUST]) {
      const s = buildStatement({
        account: "cage",
        coachName: "Coach",
        period: p,
        charges,
        payments,
      });
      // The 17,000 must never show up in any of the four figures.
      expect(s.openingCents).not.toBe(-17_000);
      expect(s.paymentsCents).not.toBe(47_000);
      expect(s.unappliedCents).toBe(17_000);
    }

    const july = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges,
      payments,
    });
    expect(july.openingCents).toBe(0);
    expect(july.chargesCents).toBe(30_000);
    expect(july.paymentsCents).toBe(30_000);
    expect(july.closingCents).toBe(0);
    expect(july.paymentsCoveringAfterCents).toBe(0);
  });

  it("is never rendered as a period ROW either — only in unappliedCents", () => {
    const july = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges,
      payments,
    });
    expect(july.paymentRows).toHaveLength(1);
    expect(july.paymentRows[0].amountCents).toBe(30_000);
    expect(july.paymentRows.every((r) => r.coversThrough !== null)).toBe(true);
  });

  it("unappliedCents is ALL-TIME — identical from every period", () => {
    const seen = [JUNE, JULY, AUGUST].map(
      (p) =>
        buildStatement({
          account: "cage",
          coachName: "Coach",
          period: p,
          charges,
          payments,
        }).unappliedCents,
    );
    expect(seen).toEqual([17_000, 17_000, 17_000]);
  });

  it("a PENDING untagged payment is not counted as unapplied either", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges,
      payments: [payment({ amountCents: 9_900, status: "pending" })],
    });
    expect(s.unappliedCents).toBe(0);
  });

  /* 🔴 …but it must not VANISH. SPEC §5.3: "Mark recording a payment and not
   * seeing it on the statement is a support call." A pending untagged payment
   * is neither confirmed (so not unapplied money) nor dated (so in no period),
   * and it used to reach no figure AND no row — while /admin/payments showed it
   * plainly. That is the version of the defect where he has two things to fix,
   * so hiding it is the worst available response. */
  describe("🔴 a PENDING UNTAGGED payment is surfaced without moving anything", () => {
    const pendingUntagged = [
      payment({
        amountCents: 9_900,
        status: "pending",
        paidAt: at("2026-08-09", "10:00"),
        coversThrough: null,
        method: "check",
        reference: "#1042",
      }),
    ];

    function july(charges: StatementChargeInput[] = [charge("2026-07-10", 30_000)]) {
      return buildStatement({
        account: "cage",
        coachName: "Coach",
        period: JULY,
        charges,
        payments: pendingUntagged,
      });
    }

    it("appears as a pending row with NO coverage date", () => {
      expect(july().paymentRows).toEqual([
        {
          paidOn: "Aug 09",
          method: "Check",
          reference: "#1042",
          coversThrough: null,
          amountCents: 9_900,
          pending: true,
        },
      ]);
    });

    it("moves NO figure — every total is as if it were not there", () => {
      const s = july();
      const without = buildStatement({
        account: "cage",
        coachName: "Coach",
        period: JULY,
        charges: [charge("2026-07-10", 30_000)],
        payments: [],
      });
      for (const key of [
        "openingCents",
        "chargesCents",
        "paymentsCents",
        "closingCents",
        "unappliedCents",
        "chargesAfterCents",
        "paymentsCoveringAfterCents",
        "currentBalanceCents",
      ] as const) {
        expect(s[key]).toBe(without[key]);
      }
    });

    it("shows up on EVERY period's statement, because it is in none of them", () => {
      for (const p of [JUNE, JULY, AUGUST]) {
        const s = buildStatement({
          account: "cage",
          coachName: "Coach",
          period: p,
          charges: [charge("2026-07-10", 30_000)],
          payments: pendingUntagged,
        });
        expect(s.paymentRows).toHaveLength(1);
        expect(s.paymentRows[0].coversThrough).toBeNull();
      }
    });

    it("is still routed by DIRECTION, and still dropped when soft-deleted", () => {
      const wrongAccount = buildStatement({
        account: "work",
        coachName: "Coach",
        period: JULY,
        charges: [],
        payments: pendingUntagged,
      });
      expect(wrongAccount.paymentRows).toEqual([]);

      const deleted = buildStatement({
        account: "cage",
        coachName: "Coach",
        period: JULY,
        charges: [],
        payments: [
          payment({
            amountCents: 9_900,
            status: "pending",
            coversThrough: null,
            deletedAt: at("2026-08-10"),
          }),
        ],
      });
      expect(deleted.paymentRows).toEqual([]);
    });

    it("sorts alongside the period's other pending rows by paid date", () => {
      const s = buildStatement({
        account: "cage",
        coachName: "Coach",
        period: JULY,
        charges: [],
        payments: [
          ...pendingUntagged,
          payment({
            amountCents: 1_100,
            status: "pending",
            paidAt: at("2026-08-02", "10:00"),
            coversThrough: at("2026-07-31"),
          }),
        ],
      });
      expect(s.paymentRows.map((r) => [r.paidOn, r.coversThrough])).toEqual([
        ["Aug 02", "Jul 31"],
        ["Aug 09", null],
      ]);
    });
  });
});

/* ── 🔴 Fix 6 — the printed hours must be the hours the money came from. ──── */

describe("🔴 hours are printed at the precision the amount was computed at", () => {
  function workLog(startTime: string, endTime: string, cents: number, hours: number) {
    return charge("2026-07-06", cents, {
      lineLabel: "HS Summer Program",
      description: "HS Summer Program",
      rateLabel: "$30.00/hr",
      slots: null,
      hours,
      startAt: at("2026-07-06", startTime),
      endAt: at("2026-07-06", endTime),
    });
  }

  function units(charges: StatementChargeInput[]): string {
    return buildStatement({
      account: "work",
      coachName: "Coach",
      period: JULY,
      charges,
      payments: [],
    }).chargeLines[0].units;
  }

  it("a single 15-minute log reads 0.25 h, not 0.3 h", () => {
    // `toFixed(1)` printed "0.3 h" beside "$7.50". 0.3 h × $30/hr is $9.00, so
    // the line visibly failed to foot by $1.50 — on a document whose whole
    // claim is arithmetic the reader can check.
    expect(units([workLog("09:00", "09:15", 750, 0.25)])).toBe("0.25 h");
  });

  it("five of them read 1.25 h, not 1.3 h", () => {
    // The review's second case: "1.3 h" beside "$37.50" (1.25 h × $30).
    const logs = Array.from({ length: 5 }, () =>
      workLog("09:00", "09:15", 750, 0.25),
    );
    expect(units(logs)).toBe("1.25 h");
  });

  it("keeps ONE decimal where that is exact — no false precision", () => {
    // Cage hours are always `slots / 2`, so .0 or .5, and every existing label
    // in this suite ("2.0 h", "6.0 h", "0.5 h") is unchanged.
    expect(units([workLog("09:00", "12:00", 9_000, 3)])).toBe("3.0 h");
    expect(units([workLog("09:00", "09:30", 1_500, 0.5)])).toBe("0.5 h");
    expect(units([workLog("09:00", "12:45", 11_250, 3.75)])).toBe("3.75 h");
  });

  it("every printed work line foots against its own rate", () => {
    // 45 minutes at $30/hr = $22.50. Reading the line as printed has to give
    // back the amount printed beside it.
    const s = buildStatement({
      account: "work",
      coachName: "Coach",
      period: JULY,
      charges: [workLog("09:00", "09:45", 2_250, 0.75)],
      payments: [],
    });
    const line = s.chargeLines[0];
    const hours = Number(/^([\d.]+) h$/.exec(line.units)![1]);
    expect(Math.round(hours * 3_000)).toBe(line.amountCents);
  });
});

/* ── §5.3 — Pending and soft-deleted never move a balance. ──────────────── */

describe("pending and soft-deleted payments", () => {
  const charges = [charge("2026-07-10", 40_000)];

  it("a PENDING payment covering the period is SHOWN but not summed", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges,
      payments: [
        payment({
          amountCents: 12_000,
          status: "pending",
          paidAt: at("2026-08-09", "10:00"),
          coversThrough: at("2026-07-31"),
          method: "check",
          reference: "#1042",
        }),
      ],
    });

    expect(s.paymentsCents).toBe(0);
    expect(s.closingCents).toBe(40_000);
    expect(s.currentBalanceCents).toBe(40_000);
    expect(s.paymentRows).toEqual([
      {
        paidOn: "Aug 09",
        method: "Check",
        reference: "#1042",
        coversThrough: "Jul 31",
        amountCents: 12_000,
        pending: true,
      },
    ]);
  });

  it("a SOFT-DELETED payment moves nothing and is not displayed at all", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges,
      payments: [
        payment({
          amountCents: 40_000,
          coversThrough: at("2026-07-31"),
          deletedAt: at("2026-08-10", "09:00"),
        }),
      ],
    });
    expect(s.paymentsCents).toBe(0);
    expect(s.closingCents).toBe(40_000);
    expect(s.currentBalanceCents).toBe(40_000);
    expect(s.paymentRows).toEqual([]);
    expect(s.unappliedCents).toBe(0);
  });

  it("a soft-deleted UNTAGGED payment is not unapplied money either", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges,
      payments: [payment({ amountCents: 5_000, deletedAt: at("2026-08-10") })],
    });
    expect(s.unappliedCents).toBe(0);
  });
});

/* ── §10 — Direction routing. The two ledgers never cross. ──────────────── */

describe("direction routing", () => {
  const cageCharges = [charge("2026-07-05", 66_000)];
  const workCharges = [
    charge("2026-07-06", 18_000, {
      lineLabel: "HS Summer Program",
      description: "HS Summer Program",
      rateLabel: "$30.00/hr",
      slots: null,
      hours: 6,
    }),
  ];

  it("a pfa_to_coach payment does NOT touch the cage account", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: cageCharges,
      payments: [
        payment({
          amountCents: 18_000,
          direction: "pfa_to_coach",
          coversThrough: at("2026-07-31"),
        }),
      ],
    });
    expect(s.paymentsCents).toBe(0);
    expect(s.paymentRows).toEqual([]);
    expect(s.closingCents).toBe(66_000);
    expect(s.currentBalanceCents).toBe(66_000);
  });

  it("a coach_to_pfa payment does NOT touch the work account", () => {
    const s = buildStatement({
      account: "work",
      coachName: "Coach",
      period: JULY,
      charges: workCharges,
      payments: [
        payment({
          amountCents: 66_000,
          direction: "coach_to_pfa",
          coversThrough: at("2026-07-31"),
        }),
      ],
    });
    expect(s.paymentsCents).toBe(0);
    expect(s.paymentRows).toEqual([]);
    expect(s.closingCents).toBe(18_000);
    expect(s.currentBalanceCents).toBe(18_000);
  });

  it("🔴 the two accounts are NEVER summed — each keeps its own figures", () => {
    const pair = buildStatementPair({
      coachName: "Alex Milone",
      coachEmail: "alex@example.com",
      period: JULY,
      cageCharges,
      workCharges,
      payments: [
        payment({ amountCents: 66_000, coversThrough: at("2026-07-31") }),
        payment({
          amountCents: 6_000,
          direction: "pfa_to_coach",
          coversThrough: at("2026-07-31"),
        }),
      ],
    });

    // Cage: 66,000 charged, 66,000 paid → square.
    expect(pair.cage.closingCents).toBe(0);
    expect(pair.cage.paymentsCents).toBe(66_000);
    // Work: 18,000 earned, 6,000 paid out → 12,000 still owed.
    expect(pair.work.closingCents).toBe(12_000);
    expect(pair.work.paymentsCents).toBe(6_000);

    // A combined total would be 12,000 (0 + 12,000) or 78,000 (payments) —
    // neither exists on the pair, and neither account has drifted toward it.
    expect(pair.cage.chargesCents).toBe(66_000);
    expect(pair.work.chargesCents).toBe(18_000);
    expect(pair.cage.currentBalanceCents).toBe(0);
    expect(pair.work.currentBalanceCents).toBe(12_000);
    expect("totalCents" in pair).toBe(false);
  });
});

/* ── §5.2 — INVARIANT (a): the both-ways closing identity. ──────────────── */

describe("INVARIANT (a): closing balance, walked forward vs computed from scratch", () => {
  // Deliberately messy: charges either side of both boundaries, payments
  // covering before / in / after, one untagged, one pending, one deleted, and
  // both directions present.
  const cageCharges = [
    charge("2026-06-10", 8_800),
    charge("2026-07-02", 8_800),
    charge("2026-07-06", 2_800),
    charge("2026-07-31", 8_800),
    charge("2026-08-03", 13_200),
  ];
  const workCharges = [
    charge("2026-06-29", 12_000, { lineLabel: "HS Summer Program", slots: null, hours: 4 }),
    charge("2026-07-06", 18_000, { lineLabel: "HS Summer Program-Throwing", slots: null, hours: 6 }),
    charge("2026-07-20", 18_000, { lineLabel: "HS Summer Program-Throwing", slots: null, hours: 6 }),
    charge("2026-08-10", 36_000, { lineLabel: "HS Summer Program", slots: null, hours: 12 }),
  ];
  const payments = [
    payment({ amountCents: 8_800, coversThrough: at("2026-06-30") }),
    payment({ amountCents: 20_400, coversThrough: at("2026-07-31") }),
    payment({ amountCents: 13_200, coversThrough: at("2026-08-31") }),
    payment({ amountCents: 17_000, coversThrough: null }),
    payment({ amountCents: 5_000, status: "pending", coversThrough: at("2026-07-15") }),
    payment({ amountCents: 99_900, coversThrough: at("2026-07-15"), deletedAt: at("2026-08-01") }),
    payment({ amountCents: 12_000, direction: "pfa_to_coach", coversThrough: at("2026-06-30") }),
    payment({ amountCents: 18_000, direction: "pfa_to_coach", coversThrough: at("2026-07-31") }),
    payment({ amountCents: 4_000, direction: "pfa_to_coach", coversThrough: null }),
  ];

  for (const [name, p] of [
    ["June", JUNE],
    ["July", JULY],
    ["August", AUGUST],
  ] as const) {
    it(`holds on BOTH accounts for the ${name} statement`, () => {
      const pair = buildStatementPair({
        coachName: "Alex Milone",
        coachEmail: "alex@example.com",
        period: p,
        cageCharges,
        workCharges,
        payments,
      });

      // Walking forward must equal computing from scratch as of `to`. If these
      // can disagree, every figure on the page is suspect.
      expect(pair.cage.closingCents).toBe(
        balanceAsOf(cageCharges, payments, "coach_to_pfa", p.toDateExclusive),
      );
      expect(pair.work.closingCents).toBe(
        balanceAsOf(workCharges, payments, "pfa_to_coach", p.toDateExclusive),
      );

      // And the printed column has to foot, because that is the design claim.
      expect(pair.cage.openingCents + pair.cage.chargesCents - pair.cage.paymentsCents).toBe(
        pair.cage.closingCents,
      );
      expect(pair.work.openingCents + pair.work.chargesCents - pair.work.paymentsCents).toBe(
        pair.work.closingCents,
      );

      // The opening balance is itself the same identity, as of `from`.
      expect(pair.cage.openingCents).toBe(
        balanceAsOf(cageCharges, payments, "coach_to_pfa", p.fromDate),
      );
      expect(pair.work.openingCents).toBe(
        balanceAsOf(workCharges, payments, "pfa_to_coach", p.fromDate),
      );

      // The summary lines must add to the charges figure above them.
      expect(pair.cage.chargeLines.reduce((n, l) => n + l.amountCents, 0)).toBe(
        pair.cage.chargesCents,
      );
      expect(pair.work.chargeLines.reduce((n, l) => n + l.amountCents, 0)).toBe(
        pair.work.chargesCents,
      );
      // …and so must the itemized rows beneath them.
      expect(pair.cage.chargeRows.reduce((n, r) => n + r.amountCents, 0)).toBe(
        pair.cage.chargesCents,
      );
      expect(pair.work.chargeRows.reduce((n, r) => n + r.amountCents, 0)).toBe(
        pair.work.chargesCents,
      );
    });
  }

  /* ── §7 — INVARIANT (b): reconciliation to the all-time figure. ───────── */

  for (const [name, p] of [
    ["June", JUNE],
    ["July", JULY],
    ["August", AUGUST],
  ] as const) {
    it(`INVARIANT (b): reconciles to netCoachLedgers on BOTH accounts (${name})`, () => {
      const pair = buildStatementPair({
        coachName: "Alex Milone",
        coachEmail: "alex@example.com",
        period: p,
        cageCharges,
        workCharges,
        payments,
      });

      // The all-time figure /admin/payments already shows, from the SAME
      // helper, computed here independently of the engine.
      const ledgers = netCoachLedgers(
        sum(cageCharges),
        sum(workCharges),
        confirmedLedgerRows(payments),
      );

      expect(pair.cage.currentBalanceCents).toBe(ledgers.cageBalanceCents);
      expect(pair.work.currentBalanceCents).toBe(ledgers.workBalanceCents);

      // closing + charges after − payments covering after − unapplied = current
      expect(
        pair.cage.closingCents +
          pair.cage.chargesAfterCents -
          pair.cage.paymentsCoveringAfterCents -
          pair.cage.unappliedCents,
      ).toBe(ledgers.cageBalanceCents);
      expect(
        pair.work.closingCents +
          pair.work.chargesAfterCents -
          pair.work.paymentsCoveringAfterCents -
          pair.work.unappliedCents,
      ).toBe(ledgers.workBalanceCents);
    });
  }

  it("the single-account builder reports the same all-time balances as the pair", () => {
    const pair = buildStatementPair({
      coachName: "Alex Milone",
      coachEmail: "alex@example.com",
      period: JULY,
      cageCharges,
      workCharges,
      payments,
    });
    const cage = buildStatement({
      account: "cage",
      coachName: "Alex Milone",
      period: JULY,
      charges: cageCharges,
      payments,
    });
    const work = buildStatement({
      account: "work",
      coachName: "Alex Milone",
      period: JULY,
      charges: workCharges,
      payments,
    });
    expect(cage).toEqual(pair.cage);
    expect(work).toEqual(pair.work);
  });
});

/* ── §5.2 — Overpayment renders as a credit, never resolved across accounts. */

describe("overpayment", () => {
  const cageCharges = [charge("2026-07-05", 20_000)];
  const workCharges = [
    charge("2026-07-06", 120_000, { lineLabel: "HS Summer Program", slots: null, hours: 40 }),
  ];
  const payments = [
    payment({ amountCents: 24_000, coversThrough: at("2026-07-31") }),
  ];

  const pair = buildStatementPair({
    coachName: "Alex Milone",
    coachEmail: "alex@example.com",
    period: JULY,
    cageCharges,
    workCharges,
    payments,
  });

  it("a negative cage closing is a CREDIT, and the direction FLIPS to say so", () => {
    expect(pair.cage.closingCents).toBe(-4_000);
    // The card renders Math.abs(closing) + a "credit" badge, so the label
    // beside it has to be the direction that is actually true.
    expect(pair.cage.directionLabel).toBe("PFA owes Alex Milone");
    expect(pair.cage.directionLabel).not.toContain("-");
    expect(pair.cage.directionLabel).not.toContain("$");
  });

  it("is NOT resolved by reaching into the work account", () => {
    // Work is untouched: still the full 120,000, not 116,000.
    expect(pair.work.closingCents).toBe(120_000);
    expect(pair.work.paymentsCents).toBe(0);
    expect(pair.work.directionLabel).toBe("PFA owes Alex Milone");
    // And the cage credit is still a cage credit all-time.
    expect(pair.cage.currentBalanceCents).toBe(-4_000);
    expect(pair.work.currentBalanceCents).toBe(120_000);
  });

  it("an overpaid WORK account flips the other way", () => {
    const overpaidWork = buildStatement({
      account: "work",
      coachName: "Alex Milone",
      period: JULY,
      charges: workCharges,
      payments: [
        payment({
          amountCents: 130_000,
          direction: "pfa_to_coach",
          coversThrough: at("2026-07-31"),
        }),
      ],
    });
    expect(overpaidWork.closingCents).toBe(-10_000);
    expect(overpaidWork.directionLabel).toBe("Alex Milone owes PFA");
  });

  it("a ZERO closing keeps the account's stated direction — square is not a flip", () => {
    const square = buildStatement({
      account: "cage",
      coachName: "Alex Milone",
      period: JULY,
      charges: cageCharges,
      payments: [payment({ amountCents: 20_000, coversThrough: at("2026-07-31") })],
    });
    expect(square.closingCents).toBe(0);
    expect(square.directionLabel).toBe("Alex Milone owes PFA");
  });
});

/* ── §11 — Caveat, scope note, labels. ─────────────────────────────────── */

describe("labels, caveat and scope note", () => {
  const pair = buildStatementPair({
    coachName: "Alex Milone",
    coachEmail: "alexmilone@example.com",
    period: JULY,
    cageCharges: [charge("2026-07-02", 8_800)],
    workCharges: [
      charge("2026-07-06", 18_000, {
        lineLabel: "HS Summer Program-Throwing",
        description: "HS Summer Program-Throwing",
        rateLabel: "$30.00/hr",
        slots: null,
        hours: 6,
        startAt: at("2026-07-06", "09:00"),
        endAt: at("2026-07-06", "15:00"),
      }),
    ],
    payments: [],
  });

  it("the caveat is on the WORK account only", () => {
    expect(pair.work.caveat).toBe(
      "This is what the logged work is worth — not what is still owed. " +
        "Payments made outside the app are not deducted here.",
    );
    expect(pair.cage.caveat).toBeNull();
  });

  it("the scope note is on the WORK account only", () => {
    expect(pair.work.scopeNote).toBe(
      "Posted work only — rejected and held logs are excluded.",
    );
    expect(pair.cage.scopeNote).toBeNull();
  });

  it("direction labels are full sentences with real names", () => {
    expect(pair.cage.directionLabel).toBe("Alex Milone owes PFA");
    expect(pair.work.directionLabel).toBe("PFA owes Alex Milone");
    for (const label of [pair.cage.directionLabel, pair.work.directionLabel]) {
      expect(label).not.toMatch(/balance|you owe/i);
      expect(label).not.toMatch(/\d/);
    }
  });

  it("period + opening + closing labels name real PFA days", () => {
    expect(pair.periodLabel).toBe("Jul 1 – Jul 31, 2026");
    expect(pair.periodEndShort).toBe("Jul 31");
    expect(pair.cage.openingLabel).toBe("Previous balance (as of Jun 30)");
    expect(pair.cage.closingLabel).toBe("Statement balance as of Jul 31");
  });

  it("a cross-year period labels both years", () => {
    const newYear = buildStatementPair({
      coachName: "Coach",
      coachEmail: "c@example.com",
      period: period("2025-12-28", "2026-01-03"),
      cageCharges: [],
      workCharges: [],
      payments: [],
    });
    expect(newYear.periodLabel).toBe("Dec 28, 2025 – Jan 3, 2026");
    expect(newYear.cage.openingLabel).toBe("Previous balance (as of Dec 27)");
  });

  it("charge rows and summary lines are formatted for the document", () => {
    expect(pair.cage.chargeRows).toEqual([
      {
        // Padded in the table column, per StatementChargeRow's contract.
        date: "Jul 02",
        dayOfWeek: "Thu",
        // Built from formatPfaTime12h rather than a literal: newer ICU emits a
        // NARROW NO-BREAK SPACE before AM/PM and a hard-coded string would
        // then pass on one Node version and fail on another.
        timeRange: `9:00 – ${formatPfaTime12h(at("2026-07-02", "11:00"))}`,
        description: "Cage 2",
        // Straight off the fixture's `rateLabel`, which is a literal here —
        // this test covers row SHAPING, not the rate convention (that is
        // "a printed cage row can be verified by hand", below).
        rateLabel: "$44.00/hr",
        slots: 4,
        amountCents: 8_800,
      },
    ]);
    expect(pair.cage.chargeLines).toEqual([
      { label: "Cage", units: "4 slots · 2.0 h", amountCents: 8_800 },
    ]);
    // Work has no slot model, and its time range crosses the meridiem — so
    // BOTH ends keep their AM/PM rather than collapsing.
    expect(pair.work.chargeLines).toEqual([
      { label: "HS Summer Program-Throwing", units: "6.0 h", amountCents: 18_000 },
    ]);
    expect(pair.work.chargeRows[0].timeRange).toBe(
      `${formatPfaTime12h(at("2026-07-06", "09:00"))} – ${formatPfaTime12h(
        at("2026-07-06", "15:00"),
      )}`,
    );
    expect(pair.work.chargeRows[0].timeRange).toMatch(/AM.*PM/);
  });

  it("cage summary lines come out in the canonical Reports order", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: [
        charge("2026-07-18", 2_000, { lineLabel: "Group weight room", slots: 2, hours: 1 }),
        charge("2026-07-06", 2_800, { lineLabel: "Weight room", slots: 4, hours: 2 }),
        charge("2026-07-09", 8_800, { lineLabel: "Bullpen", slots: 4, hours: 2 }),
        charge("2026-07-02", 8_800, { lineLabel: "Cage", slots: 4, hours: 2 }),
      ],
      payments: [],
    });
    expect(s.chargeLines.map((l) => l.label)).toEqual([
      "Cage",
      "Bullpen",
      "Weight room",
      "Group weight room",
    ]);
    // Rows stay chronological regardless of the summary's order.
    expect(s.chargeRows.map((r) => r.date)).toEqual([
      "Jul 02",
      "Jul 06",
      "Jul 09",
      "Jul 18",
    ]);
  });

  it("a single slot is singular, and a $0-rate line is kept rather than suppressed", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: [charge("2026-07-02", 0, { slots: 1, hours: 0.5 })],
      payments: [],
    });
    expect(s.chargeLines).toEqual([
      { label: "Cage", units: "1 slot · 0.5 h", amountCents: 0 },
    ]);
  });

  it("an empty period yields empty rows and zeroed figures, not invented ones", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: [],
      payments: [],
    });
    expect(s.chargeLines).toEqual([]);
    expect(s.chargeRows).toEqual([]);
    expect(s.paymentRows).toEqual([]);
    expect([s.openingCents, s.chargesCents, s.paymentsCents, s.closingCents]).toEqual([
      0, 0, 0, 0,
    ]);
    expect(s.currentBalanceCents).toBe(0);
  });
});

/* ── §10 — The work account must agree with /admin/reports?tab=work. ────── */

describe("agreement with the shipped Work hours tab (SPEC §10)", () => {
  function log(over: Partial<HourLogFetchRow>): HourLogFetchRow {
    return {
      id: "log-1",
      coachId: "alex",
      coachName: "Alex Milone",
      coachEmail: "alex@example.com",
      programId: "prog-1",
      programName: "HS Summer Program",
      startAt: at("2026-07-06", "09:00"),
      endAt: at("2026-07-06", "12:00"),
      note: null,
      scheduleNote: null,
      status: "posted",
      decisionReason: null,
      ratePer30MinCents: 1_500,
      perSessionRateCents: null,
      ...over,
    };
  }

  const rows: HourLogFetchRow[] = [
    log({ id: "posted-a" }),
    log({
      id: "posted-b",
      programName: "HS Summer Program-Throwing",
      startAt: at("2026-07-13", "09:00"),
      endAt: at("2026-07-13", "12:45"),
    }),
    log({ id: "per-session", startAt: at("2026-07-20", "09:00"), endAt: at("2026-07-20", "10:00"), perSessionRateCents: 10_000 }),
    log({ id: "no-rate", startAt: at("2026-07-21", "09:00"), endAt: at("2026-07-21", "10:00"), ratePer30MinCents: null }),
    // 🔴 Neither of these may reach a pay figure — the Work tab excludes both.
    log({ id: "rejected", status: "rejected", startAt: at("2026-07-22", "09:00"), endAt: at("2026-07-22", "17:00") }),
    log({ id: "held", status: "held", startAt: at("2026-07-23", "09:00"), endAt: at("2026-07-23", "17:00") }),
  ];

  const report = buildWorkReport(rows);
  const workCharges = chargesFromWorkDetail(report.detail, rows);
  const statement = buildStatement({
    account: "work",
    coachName: "Alex Milone",
    period: JULY,
    charges: workCharges,
    payments: [],
  });

  it("quotes EXACTLY the Work tab's grand total for the same coach + period", () => {
    expect(statement.chargesCents).toBe(report.grandTotalCents);
    expect(statement.chargesCents).toBe(report.summary[0].payCents);
    // 4 posted logs: 3h@$30 = 9,000 · 3.75h@$30 = 11,250 · per-session 10,000
    // · no-rate 0  →  30,250.
    expect(statement.chargesCents).toBe(30_250);
  });

  it("POSTED ONLY — held and rejected logs never reach the statement", () => {
    expect(workCharges).toHaveLength(4);
    expect(statement.chargeRows.map((r) => r.date)).toEqual([
      "Jul 06",
      "Jul 13",
      "Jul 20",
      "Jul 21",
    ]);
    // The rejected and held logs are 8 hours each at $30/hr — $240 apiece. If
    // either leaked in, the total below could not still be 30,250.
    expect(statement.chargesCents).toBe(30_250);
    expect(statement.chargesAfterCents).toBe(0);
    expect(statement.openingCents).toBe(0);
  });

  it("renders per-session, hourly and missing rates distinctly — never $0.00/hr for a missing rate", () => {
    const labels = statement.chargeRows.map((r) => r.rateLabel);
    expect(labels).toContain("$30.00/hr");
    expect(labels).toContain("$100.00/session");
    expect(labels).toContain("No rate");
    expect(labels).not.toContain("$0.00/hr");
  });

  it("throws rather than silently dropping a charge with no source row", () => {
    expect(() => chargesFromWorkDetail(report.detail, [])).toThrow(
      /no source hour log/,
    );
  });
});

describe("agreement with the shipped cage tab", () => {
  function session(over: Partial<AggregateSessionInput>): AggregateSessionInput {
    return {
      sessionId: "s1",
      coachId: "alex",
      coachName: "Alex Milone",
      coachEmail: "alex@example.com",
      resourceId: "r1",
      resourceName: "Cage 2",
      resourceType: "cage",
      startAt: at("2026-07-02", "09:00"),
      endAt: at("2026-07-02", "11:00"),
      note: null,
      ratePer30MinCents: 2_200,
      isGroupSession: false,
      ...over,
    };
  }

  const sessions: AggregateSessionInput[] = [
    session({ sessionId: "cage" }),
    session({
      sessionId: "bullpen",
      resourceType: "bullpen",
      resourceName: "Bullpen 1",
      startAt: at("2026-07-09", "16:00"),
      endAt: at("2026-07-09", "18:00"),
    }),
    session({
      sessionId: "wr",
      resourceType: "weight_room",
      resourceName: "Weight Room",
      ratePer30MinCents: 700,
      startAt: at("2026-07-06", "07:00"),
      endAt: at("2026-07-06", "09:00"),
    }),
    session({
      sessionId: "wr-group",
      resourceType: "weight_room",
      resourceName: "Weight Room",
      isGroupSession: true,
      ratePer30MinCents: 1_000,
      startAt: at("2026-07-18", "10:00"),
      endAt: at("2026-07-18", "11:00"),
    }),
  ];

  const report = aggregateReport(sessions);
  const cageCharges = chargesFromCageDetail(report.detail, sessions);

  it("quotes EXACTLY the cage tab's grand total", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Alex Milone",
      period: JULY,
      charges: cageCharges,
      payments: [],
    });
    expect(s.chargesCents).toBe(report.grandTotalCents);
    // 8,800 cage + 8,800 bullpen + 2,800 weight room + 2,000 group = 22,400.
    expect(s.chargesCents).toBe(22_400);
  });

  it("breaks group weight room out from regular weight room, and says so on the row", () => {
    const s = buildStatement({
      account: "cage",
      coachName: "Alex Milone",
      period: JULY,
      charges: cageCharges,
      payments: [],
    });
    expect(s.chargeLines).toEqual([
      { label: "Cage", units: "4 slots · 2.0 h", amountCents: 8_800 },
      { label: "Bullpen", units: "4 slots · 2.0 h", amountCents: 8_800 },
      { label: "Weight room", units: "4 slots · 2.0 h", amountCents: 2_800 },
      { label: "Group weight room", units: "2 slots · 1.0 h", amountCents: 2_000 },
    ]);
    const group = s.chargeRows.find((r) => r.date === "Jul 18");
    expect(group?.description).toBe("Weight Room (Group)");
    // Per HOUR, with a space before the unit — `RateCell`'s exact rendering,
    // now shared from `lib/reports/rate-display.ts`. Group-ness changes which
    // RATE was resolved, not the unit it is quoted in, so a group weight-room
    // session lands on "/hr" the same way a regular one does.
    expect(group?.rateLabel).toBe("$20.00 /hr");
    expect(group?.slots).toBe(2);
  });

  it("throws rather than silently dropping a charge with no source session", () => {
    expect(() => chargesFromCageDetail(report.detail, [])).toThrow(
      /no source session/,
    );
  });
});

/* ── 🔴 THE PRINTED ROW MUST MULTIPLY OUT ────────────────────────────────────
 *
 * Two defects, one fix.
 *
 * (1) The engine labelled EVERY cage rate `/hr` (`ratePerSlotCents * 2`), while
 *     the shipped Reports screen's `RateCell` quotes cage and bullpen
 *     `/30 min` and only the weight room `/hr`. Same session, same rate, two
 *     units, one tab apart.
 *
 * (2) 🔴 Worse, and the reason this is not cosmetic: the statement's charge
 *     table had NO Slots column, so an OFF-SLOT session printed a row a reader
 *     computes as a 2× overcharge. `slotsBetween`'s own docstring uses
 *     9:14–10:01 → 3 slots; that printed as
 *
 *         9:14 – 10:01 AM · $44.00/hr · $66.00
 *
 *     and a coach doing 47 minutes at $44/hr gets $34.47 and concludes he was
 *     double-charged. Nothing on the page could contradict him. SPEC §5.3 said
 *     to reuse "the existing Cage Detail column set" — which HAS a Slots column
 *     — and the mock dropped it.
 *
 * So this block reads each printed row the way a person would: take the rate and
 * unit as PRINTED, take the units as PRINTED, multiply, and require the product
 * to be the amount as PRINTED. Nothing is read out of the source rows.
 */
describe("🔴 a printed cage row can be verified by hand", () => {
  function session(over: Partial<AggregateSessionInput>): AggregateSessionInput {
    return {
      sessionId: "s1",
      coachId: "alex",
      coachName: "Alex Milone",
      coachEmail: "alex@example.com",
      resourceId: "r1",
      resourceName: "Cage 2",
      resourceType: "cage",
      startAt: at("2026-07-02", "09:00"),
      endAt: at("2026-07-02", "11:00"),
      note: null,
      ratePer30MinCents: 2_200,
      isGroupSession: false,
      ...over,
    };
  }

  /**
   * Recomputes a row's amount from ONLY what the row prints: the rate figure,
   * its unit, and the slot count. A slot is 30 minutes, which the document now
   * states in a line of copy beneath the table — so this is arithmetic a reader
   * has everything for.
   */
  function amountFromPrintedRow(rateLabel: string, slots: number): number {
    const m = /^\$([\d,]+\.\d{2}) (\/hr|\/30 min)$/.exec(rateLabel);
    if (!m) throw new Error(`unreadable rate label: ${rateLabel}`);
    const cents = Math.round(Number(m[1].replace(/,/g, "")) * 100);
    // "/30 min" → one slot per printed rate. "/hr" → two slots per printed rate.
    return m[2] === "/30 min" ? cents * slots : (cents * slots) / 2;
  }

  const SESSIONS: { name: string; input: AggregateSessionInput; rate: string; slots: number; cents: number }[] = [
    {
      name: "an ON-SLOT cage session",
      input: session({ sessionId: "on-slot" }),
      rate: "$22.00 /30 min",
      slots: 4,
      cents: 8_800,
    },
    {
      // 🔴 The case the missing column made unverifiable. 47 wall-clock minutes
      // bill as 9:00–10:30 = 3 slots.
      name: "an OFF-SLOT cage session (9:14 – 10:01)",
      input: session({
        sessionId: "off-slot",
        startAt: at("2026-07-03", "09:14"),
        endAt: at("2026-07-03", "10:01"),
      }),
      rate: "$22.00 /30 min",
      slots: 3,
      cents: 6_600,
    },
    {
      name: "a bullpen session",
      input: session({
        sessionId: "bullpen",
        resourceType: "bullpen",
        resourceName: "Bullpen 1",
        startAt: at("2026-07-09", "16:00"),
        endAt: at("2026-07-09", "18:00"),
      }),
      rate: "$22.00 /30 min",
      slots: 4,
      cents: 8_800,
    },
    {
      // The one resource `RateCell` quotes per HOUR — matched exactly.
      name: "a weight-room session",
      input: session({
        sessionId: "wr",
        resourceType: "weight_room",
        resourceName: "Weight Room",
        ratePer30MinCents: 700,
        startAt: at("2026-07-06", "07:00"),
        endAt: at("2026-07-06", "09:00"),
      }),
      rate: "$14.00 /hr",
      slots: 4,
      cents: 2_800,
    },
    {
      name: "a GROUP weight-room session",
      input: session({
        sessionId: "wr-group",
        resourceType: "weight_room",
        resourceName: "Weight Room",
        isGroupSession: true,
        ratePer30MinCents: 1_000,
        startAt: at("2026-07-18", "10:00"),
        endAt: at("2026-07-18", "11:00"),
      }),
      rate: "$20.00 /hr",
      slots: 2,
      cents: 2_000,
    },
  ];

  const inputs = SESSIONS.map((c) => c.input);
  const statement = buildStatement({
    account: "cage",
    coachName: "Alex Milone",
    period: JULY,
    charges: chargesFromCageDetail(aggregateReport(inputs).detail, inputs),
    payments: [],
  });

  it.each(SESSIONS)(
    "prints the rate in the SAME unit the Reports screen does: $name",
    ({ input, rate }) => {
      const row = statement.chargeRows.find(
        (r) => r.amountCents !== undefined && r.date === expectedDate(input),
      );
      expect(row?.rateLabel).toBe(rate);
    },
  );

  it.each(SESSIONS)("carries the slot count on the row: $name", ({ input, slots }) => {
    const row = statement.chargeRows.find((r) => r.date === expectedDate(input));
    expect(row?.slots).toBe(slots);
  });

  it.each(SESSIONS)("🔴 the row FOOTS as printed: $name", ({ input, cents }) => {
    const row = statement.chargeRows.find((r) => r.date === expectedDate(input))!;
    expect(row.amountCents).toBe(cents);
    expect(amountFromPrintedRow(row.rateLabel, row.slots!)).toBe(row.amountCents);
  });

  function expectedDate(input: AggregateSessionInput): string {
    return input.startAt.toLocaleDateString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "2-digit",
    });
  }

  it("every cage row on the document foots, with no exception", () => {
    for (const row of statement.chargeRows) {
      expect(row.slots).not.toBeNull();
      expect(amountFromPrintedRow(row.rateLabel, row.slots!)).toBe(
        row.amountCents,
      );
    }
    expect(statement.chargeRows).toHaveLength(5);
  });

  it("a $0 cage rate still prints a figure — a comp is not a missing rate", () => {
    // `ratePerSlotCents` is NOT NULL on `sessions_billing`, so $0 is deliberate.
    // "No rate" belongs to the work account's nullable snapshots only.
    const comped = [session({ sessionId: "comp", ratePer30MinCents: 0 })];
    const s = buildStatement({
      account: "cage",
      coachName: "Coach",
      period: JULY,
      charges: chargesFromCageDetail(aggregateReport(comped).detail, comped),
      payments: [],
    });
    expect(s.chargeRows[0].rateLabel).toBe("$0.00 /30 min");
    expect(s.chargeRows[0].amountCents).toBe(0);
  });
});

describe("the WORK account's rate labels and slots are unchanged", () => {
  function log(over: Partial<HourLogFetchRow>): HourLogFetchRow {
    return {
      id: "log-1",
      coachId: "alex",
      coachName: "Alex Milone",
      coachEmail: "alex@example.com",
      programId: "prog-1",
      programName: "HS Summer Program",
      startAt: at("2026-07-06", "09:00"),
      endAt: at("2026-07-06", "12:00"),
      note: null,
      scheduleNote: null,
      status: "posted",
      decisionReason: null,
      ratePer30MinCents: 1_500,
      perSessionRateCents: null,
      ...over,
    };
  }

  const rows = [
    log({ id: "hourly" }),
    log({ id: "per-session", startAt: at("2026-07-20", "09:00"), endAt: at("2026-07-20", "10:00"), perSessionRateCents: 10_000 }),
    log({ id: "no-rate", startAt: at("2026-07-21", "09:00"), endAt: at("2026-07-21", "10:00"), ratePer30MinCents: null }),
  ];
  const report = buildWorkReport(rows);
  const statement = buildStatement({
    account: "work",
    coachName: "Alex Milone",
    period: JULY,
    charges: chargesFromWorkDetail(report.detail, rows),
    payments: [],
  });

  it("keeps /hr, /session and No rate exactly as shipped — no space, no slots", () => {
    // The cage fix must not leak across. The work side has no slot model, so a
    // slot count there would be a fiction, and a "/30 min" unit would be a
    // second way to say the same rate.
    expect(statement.chargeRows.map((r) => r.rateLabel)).toEqual([
      "$30.00/hr",
      "$100.00/session",
      "No rate",
    ]);
    expect(statement.chargeRows.map((r) => r.slots)).toEqual([null, null, null]);
  });
});

/* ── §8.1 — The many-coach roll-up. ────────────────────────────────────── */

describe("buildStatementRoster", () => {
  const coaches = [
    {
      coachId: "serena",
      coachName: "Serena Rodriguez",
      coachEmail: "serena@example.com",
      cageCharges: [charge("2026-07-04", 4_400)],
      workCharges: [] as StatementChargeInput[],
      payments: [] as StatementPaymentInput[],
    },
    {
      coachId: "alex",
      coachName: "Alex Milone",
      coachEmail: "alex@example.com",
      cageCharges: [charge("2026-06-10", 8_800), charge("2026-07-02", 66_000), charge("2026-08-03", 13_200)],
      workCharges: [charge("2026-07-06", 120_000, { lineLabel: "HS Summer Program", slots: null, hours: 40 })],
      payments: [
        payment({ amountCents: 66_000, coversThrough: at("2026-07-31") }),
        payment({ amountCents: 17_000, coversThrough: null }),
        payment({ amountCents: 4_000, direction: "pfa_to_coach", coversThrough: null }),
      ],
    },
    {
      coachId: "jorge",
      coachName: "Jorge Romero",
      coachEmail: "jorge@example.com",
      cageCharges: [charge("2026-07-11", 8_000)],
      workCharges: [] as StatementChargeInput[],
      payments: [payment({ amountCents: 12_000, coversThrough: at("2026-07-31") })],
    },
  ];

  const rows = buildStatementRoster({ period: JULY, coaches });

  it("is sorted by coach name", () => {
    expect(rows.map((r) => r.coachName)).toEqual([
      "Alex Milone",
      "Jorge Romero",
      "Serena Rodriguez",
    ]);
  });

  it("carries the RANGED + NETTED closing balances, per account, never summed", () => {
    const alex = rows[0];
    // Cage: June 8,800 opening + July 66,000 − 66,000 paid = 8,800.
    expect(alex.cageBalanceCents).toBe(8_800);
    expect(alex.workBalanceCents).toBe(120_000);
    // A summed row would be 128,800 — no field holds it.
    expect(Object.keys(alex).sort()).toEqual([
      "cageBalanceCents",
      "coachId",
      "coachName",
      "unappliedCents",
      "workBalanceCents",
    ]);
  });

  it("each row equals the statement it links to", () => {
    for (const coach of coaches) {
      const pair = buildStatementPair({ ...coach, period: JULY });
      const row = rows.find((r) => r.coachId === coach.coachId)!;
      expect(row.cageBalanceCents).toBe(pair.cage.closingCents);
      expect(row.workBalanceCents).toBe(pair.work.closingCents);
    }
  });

  it("⚠️ unappliedCents is ALL-TIME (both directions) — identical from every period", () => {
    // Alex: 17,000 untagged coach→PFA + 4,000 untagged PFA→coach = 21,000.
    expect(rows[0].unappliedCents).toBe(21_000);
    for (const p of [JUNE, AUGUST]) {
      const other = buildStatementRoster({ period: p, coaches });
      expect(other[0].unappliedCents).toBe(21_000);
    }
    // …while the balances DO move with the period, which is the contrast that
    // makes the column's "all time" label load-bearing.
    const august = buildStatementRoster({ period: AUGUST, coaches });
    expect(august[0].cageBalanceCents).toBe(22_000);
    expect(august[0].workBalanceCents).toBe(120_000);
  });

  it("🔴 the roll-up's untagged figure IS the two accounts' figures added", () => {
    // The relationship the roster's column label and footnote now assert in
    // words, pinned here so it is a contract rather than an incident. Alex has
    // untagged money in BOTH directions, which is the only case where the three
    // figures differ — and the case that made one label name three numbers:
    //
    //   roster column   $210.00   ← cage 170 + work 40, this line
    //   cage statement  $170.00   ← pair.cage.unappliedCents
    //   work statement   $40.00   ← pair.work.unappliedCents
    //
    // Combining the two directions is legitimate ONLY because this is a count
    // of MONEY THAT NEEDS A DATE and not a balance (see `StatementRosterEntry`),
    // so nothing may ever derive a direction from it. What must hold is that it
    // is exactly the sum of the two documents it sits beside, so a reader who
    // opens both statements can reconcile the roster row by adding.
    const both = {
      coachId: "both",
      coachName: "Two-Way Coach",
      coachEmail: "both@example.com",
      cageCharges: [charge("2026-07-04", 50_000)],
      workCharges: [
        charge("2026-07-05", 9_000, { lineLabel: "HS Summer Program", slots: null, hours: 3 }),
      ],
      payments: [
        payment({ amountCents: 17_000, coversThrough: null }),
        payment({ amountCents: 4_000, direction: "pfa_to_coach", coversThrough: null }),
      ],
    };

    const [row] = buildStatementRoster({ period: JULY, coaches: [both] });
    const pair = buildStatementPair({ ...both, period: JULY });

    expect(pair.cage.unappliedCents).toBe(17_000);
    expect(pair.work.unappliedCents).toBe(4_000);
    expect(row.unappliedCents).toBe(
      pair.cage.unappliedCents + pair.work.unappliedCents,
    );
    // Spelled out too, so a change to either side has to change this number.
    expect(row.unappliedCents).toBe(21_000);
    // …and it is STRICTLY LARGER than either statement's own figure, which is
    // the whole reason the column may not wear the statement's label.
    expect(row.unappliedCents).toBeGreaterThan(pair.cage.unappliedCents);
    expect(row.unappliedCents).toBeGreaterThan(pair.work.unappliedCents);
  });

  it("a credit shows as a negative balance for the card to render in parentheses", () => {
    const jorge = rows.find((r) => r.coachId === "jorge")!;
    expect(jorge.cageBalanceCents).toBe(-4_000);
  });

  it("zero coaches in scope yields zero rows, not a row of zeroes", () => {
    expect(buildStatementRoster({ period: JULY, coaches: [] })).toEqual([]);
  });
});
