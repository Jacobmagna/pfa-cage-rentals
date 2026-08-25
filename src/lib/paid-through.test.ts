// Unit tests for the "have I already paid for this day?" decision.
//
// Everything the guard DECIDES lives in the pure module, so everything it
// decides is provable here with literals — which payout gets quoted, where the
// day boundary falls, and the exact words the admin reads. The server module
// next door only runs a query and hands the rows over.
//
// 🔴 Dates are built through `parsePfaInput`, never `new Date("...")`. Both
// `hour_logs.start_at` and `coach_payments.covers_through` are stored at PFA
// wall-clock, and the whole guard is a comparison between two of them — so a
// test that constructs its fixtures in the runner's local zone would pass in
// Los Angeles and fail in UTC, on a boundary that IS the feature. The unit
// suite is run under four timezones for exactly this class of bug.

import { describe, expect, it } from "vitest";
import {
  findPayoutCovering,
  paidThroughMessage,
  type RecordedPayout,
} from "./paid-through";
import { parsePfaInput, pfaDayStart } from "./timezone";

/** PFA-midnight of a `YYYY-MM-DD` day — the convention both columns use. */
const day = (d: string) => parsePfaInput(d, "00:00");

const payout = (over: Partial<RecordedPayout> = {}): RecordedPayout => ({
  id: "p1",
  amountCents: 124_000,
  paidAt: day("2026-08-03"),
  coversThrough: day("2026-07-31"),
  status: "confirmed",
  ...over,
});

describe("findPayoutCovering", () => {
  it("returns null when there are no payouts at all", () => {
    expect(findPayoutCovering(day("2026-07-12"), [])).toBeNull();
  });

  it("finds a payout whose coverage reaches past the log's day", () => {
    const found = findPayoutCovering(day("2026-07-12"), [payout()]);
    expect(found?.payout.id).toBe("p1");
    expect(found?.coveringCount).toBe(1);
  });

  it("ignores a payout that stops before the log's day", () => {
    // Paid through Jul 11; the hours are Jul 12. Nothing has settled them.
    const found = findPayoutCovering(day("2026-07-12"), [
      payout({ coversThrough: day("2026-07-11") }),
    ]);
    expect(found).toBeNull();
  });

  // 🔴 THE BOUNDARY IS THE FEATURE. "Paid through Jul 12" settles work done
  // ON Jul 12 — `through` is inclusive of the day it names. An exclusive
  // comparison here would stay silent on the single most likely real case:
  // hours entered for the last day a payout claimed to cover.
  it("fires when the coverage date IS the log's day", () => {
    const found = findPayoutCovering(day("2026-07-12"), [
      payout({ coversThrough: day("2026-07-12") }),
    ]);
    expect(found?.payout.id).toBe("p1");
  });

  // The caller passes PFA-midnight of the log's date, not the log's own
  // instant. A 6 PM log on Jul 12 must read identically to a 9 AM one — the
  // guard is about the DAY, and a time-of-day comparison against a midnight
  // coverage date would silently spare every log after 00:00.
  it("is decided by the log's DAY, not its time of day", () => {
    const evening = parsePfaInput("2026-07-12", "18:00");
    const found = findPayoutCovering(pfaDayStart(evening), [
      payout({ coversThrough: day("2026-07-12") }),
    ]);
    expect(found?.payout.id).toBe("p1");
  });

  it("counts a pending payout — it is still Mark saying he paid", () => {
    const found = findPayoutCovering(day("2026-07-12"), [
      payout({ status: "pending" }),
    ]);
    expect(found?.payout.status).toBe("pending");
  });

  it("quotes the payout reaching furthest past the day, and counts them all", () => {
    const found = findPayoutCovering(day("2026-07-12"), [
      payout({ id: "near", coversThrough: day("2026-07-15") }),
      payout({ id: "far", coversThrough: day("2026-07-31") }),
      payout({ id: "before", coversThrough: day("2026-07-01") }),
    ]);
    expect(found?.payout.id).toBe("far");
    // "before" does not cover Jul 12 and must not be counted.
    expect(found?.coveringCount).toBe(2);
  });

  it("breaks a coverage tie on the more recent payment", () => {
    const found = findPayoutCovering(day("2026-07-12"), [
      payout({ id: "old", paidAt: day("2026-08-01") }),
      payout({ id: "new", paidAt: day("2026-08-09") }),
    ]);
    expect(found?.payout.id).toBe("new");
  });

  // A total order matters more than which id wins: without it the quoted
  // payout could differ between two renders of the same screen, and an admin
  // who re-reads a warning and sees a different payment stops trusting it.
  it("is deterministic when coverage and payment date both tie", () => {
    const rows = [
      payout({ id: "aaa" }),
      payout({ id: "zzz" }),
      payout({ id: "mmm" }),
    ];
    const forwards = findPayoutCovering(day("2026-07-12"), rows);
    const backwards = findPayoutCovering(day("2026-07-12"), [...rows].reverse());
    expect(forwards?.payout.id).toBe(backwards?.payout.id);
  });
});

describe("paidThroughMessage", () => {
  const finding = { payout: payout(), coveringCount: 1 };

  it("names the coach, the amount, both dates and the consequence", () => {
    const msg = paidThroughMessage(
      "Lucas Milone",
      parsePfaInput("2026-07-12", "10:00"),
      finding,
    );
    expect(msg).toContain("Lucas Milone");
    expect(msg).toContain("paid through Jul 31, 2026");
    expect(msg).toContain("recorded on Aug 3, 2026");
    expect(msg).toContain("dated Jul 12, 2026");
    expect(msg).toContain("owed");
  });

  // Rule F6's class, and it has shipped in this repo before: a warning that
  // prints "$124000.00" beside the card's "$1,240.00" reads as two different
  // numbers for one amount, inside the most important sentence on the screen.
  it("prints money with separators and exact cents", () => {
    const msg = paidThroughMessage(
      "Lucas Milone",
      day("2026-07-12"),
      finding,
    );
    expect(msg).toContain("$1,240.00");
    expect(msg).not.toContain("124000");
  });

  it("says so when the quoted payout is unconfirmed", () => {
    const msg = paidThroughMessage("Lucas Milone", day("2026-07-12"), {
      payout: payout({ status: "pending" }),
      coveringCount: 1,
    });
    expect(msg).toContain("not yet confirmed");
  });

  it("stays silent about confirmation when the payout is confirmed", () => {
    const msg = paidThroughMessage("Lucas Milone", day("2026-07-12"), finding);
    expect(msg).not.toContain("not yet confirmed");
  });

  it("mentions the other covering payouts, singular and plural", () => {
    const two = paidThroughMessage("Lucas Milone", day("2026-07-12"), {
      payout: payout(),
      coveringCount: 2,
    });
    expect(two).toContain("1 other recorded payout covers this day");

    const three = paidThroughMessage("Lucas Milone", day("2026-07-12"), {
      payout: payout(),
      coveringCount: 3,
    });
    expect(three).toContain("2 other recorded payouts cover this day");
  });

  it("says nothing about other payouts when there is only one", () => {
    const msg = paidThroughMessage("Lucas Milone", day("2026-07-12"), finding);
    expect(msg).not.toContain("other recorded");
  });

  // The refusal is a DECISION, not a scolding. F7's lesson one level over:
  // a message that tells a non-technical admin what he must not do, about an
  // action that is usually correct, teaches him to click past it.
  it("does not tell the admin the entry is wrong", () => {
    const msg = paidThroughMessage("Lucas Milone", day("2026-07-12"), finding);
    for (const scold of ["cannot", "should not", "must not", "error"]) {
      expect(msg.toLowerCase()).not.toContain(scold);
    }
  });
});
