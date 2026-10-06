// Unit tests for the payment-history paging rules (payments-load-more SPEC
// §7.1). Everything the list says about itself — the row limit it accepts
// from the URL, the caption, whether the buttons show and what they read — is
// decided in history.ts, so it is pinned here as tables.

import { describe, expect, it } from "vitest";
import {
  PAYMENT_HISTORY_CAP,
  PAYMENT_HISTORY_STEP,
  moreButtonCount,
  normalizeShown,
  paymentHistoryControls,
  paymentHistoryHref,
  summarizePaymentHistory,
} from "./history";

describe("constants", () => {
  it("steps by 100 and caps at 2,000", () => {
    expect(PAYMENT_HISTORY_STEP).toBe(100);
    expect(PAYMENT_HISTORY_CAP).toBe(2000);
  });
});

describe("normalizeShown — searchParams is hostile input", () => {
  const cases: Array<[string | string[] | undefined, number]> = [
    [undefined, 100],
    ["", 100],
    ["abc", 100],
    ["0", 100],
    ["-5", 100],
    ["99", 100],
    ["100", 100],
    ["250", 250],
    ["2.5", 100],
    ["1e9", 100],
    ["all", 2000],
    ["ALL", 2000],
    [["300", "900"], 300],
    ["2000", 2000],
    ["2001", 2000],
  ];

  it.each(cases)("%j → %i", (raw, expected) => {
    expect(normalizeShown(raw)).toBe(expected);
  });

  it("always returns a finite integer between the step and the cap", () => {
    const hostile: Array<string | string[] | undefined> = [
      ...cases.map(([raw]) => raw),
      [],
      ["abc", "300"],
      " 200",
      "200 ",
      "+200",
      "0x64",
      "Infinity",
      "NaN",
      "999999999999999999999999",
      "9".repeat(400),
      "allx",
    ];
    for (const raw of hostile) {
      const n = normalizeShown(raw);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(PAYMENT_HISTORY_STEP);
      expect(n).toBeLessThanOrEqual(PAYMENT_HISTORY_CAP);
    }
  });

  it("an empty array, or an array whose first value is junk, is the default", () => {
    expect(normalizeShown([])).toBe(100);
    expect(normalizeShown(["abc", "300"])).toBe(100);
  });

  it("a digit string too large for a number clamps to the cap", () => {
    expect(normalizeShown("999999999999999999999999")).toBe(2000);
    expect(normalizeShown("9".repeat(400))).toBe(2000);
  });
});

describe("summarizePaymentHistory", () => {
  it("count 0 — no caption (the table's empty state speaks), no buttons", () => {
    const s = summarizePaymentHistory({ shown: 100, rowCount: 0, count: 0 });
    expect(s).toEqual({
      total: 0,
      visible: 0,
      hasMore: false,
      nextShown: 200,
      remaining: 0,
      capped: false,
      caption: "",
    });
    expect(paymentHistoryControls(s)).toBeNull();
  });

  it("count 1 — singular caption, no buttons", () => {
    const s = summarizePaymentHistory({ shown: 100, rowCount: 1, count: 1 });
    expect(s.total).toBe(1);
    expect(s.visible).toBe(1);
    expect(s.remaining).toBe(0);
    expect(s.hasMore).toBe(false);
    expect(s.capped).toBe(false);
    expect(s.caption).toBe("1 payment.");
    expect(paymentHistoryControls(s)).toBeNull();
  });

  it("count 40 — everything fits, says 'all', no buttons", () => {
    const s = summarizePaymentHistory({ shown: 100, rowCount: 40, count: 40 });
    expect(s.total).toBe(40);
    expect(s.visible).toBe(40);
    expect(s.remaining).toBe(0);
    expect(s.hasMore).toBe(false);
    expect(s.capped).toBe(false);
    expect(s.caption).toBe("Showing all 40 payments.");
    expect(paymentHistoryControls(s)).toBeNull();
  });

  it("count exactly 100 — the off-by-one: all shown, NO buttons", () => {
    const s = summarizePaymentHistory({ shown: 100, rowCount: 100, count: 100 });
    expect(s.total).toBe(100);
    expect(s.visible).toBe(100);
    expect(s.remaining).toBe(0);
    expect(s.hasMore).toBe(false);
    expect(s.capped).toBe(false);
    expect(s.caption).toBe("Showing all 100 payments.");
    expect(paymentHistoryControls(s)).toBeNull();
  });

  it("count 101 — one remains, the button reads 'Show 1 more'", () => {
    const s = summarizePaymentHistory({ shown: 100, rowCount: 100, count: 101 });
    expect(s.total).toBe(101);
    expect(s.visible).toBe(100);
    expect(s.remaining).toBe(1);
    expect(s.hasMore).toBe(true);
    expect(s.nextShown).toBe(200);
    expect(s.capped).toBe(false);
    expect(s.caption).toBe("Showing the 100 most recent of 101 payments.");
    expect(moreButtonCount(s)).toBe(1);
    expect(paymentHistoryControls(s)).toEqual({
      more: {
        shown: 200,
        label: "Show 1 more",
        ariaLabel: "Show 1 more payments",
      },
      all: {
        shown: 2000,
        label: "Show all (101)",
        ariaLabel: "Show all 101 payments",
      },
    });
  });

  it("count 243 at the default — a full step is on offer", () => {
    const s = summarizePaymentHistory({ shown: 100, rowCount: 100, count: 243 });
    expect(s.remaining).toBe(143);
    expect(s.hasMore).toBe(true);
    expect(s.caption).toBe("Showing the 100 most recent of 243 payments.");
    expect(moreButtonCount(s)).toBe(100);
    expect(paymentHistoryControls(s)).toEqual({
      more: {
        shown: 200,
        label: "Show 100 more",
        ariaLabel: "Show 100 more payments",
      },
      all: {
        shown: 2000,
        label: "Show all (243)",
        ariaLabel: "Show all 243 payments",
      },
    });
  });

  it("count 250 at shown 200 — 50 remain, the button reads 'Show 50 more'", () => {
    const s = summarizePaymentHistory({ shown: 200, rowCount: 200, count: 250 });
    expect(s.total).toBe(250);
    expect(s.visible).toBe(200);
    expect(s.remaining).toBe(50);
    expect(s.hasMore).toBe(true);
    expect(s.nextShown).toBe(300);
    expect(s.capped).toBe(false);
    expect(s.caption).toBe("Showing the 200 most recent of 250 payments.");
    expect(moreButtonCount(s)).toBe(50);
    expect(paymentHistoryControls(s)?.more).toEqual({
      shown: 300,
      label: "Show 50 more",
      ariaLabel: "Show 50 more payments",
    });
  });

  it("count 250 at shown 300 — all shown, no buttons", () => {
    const s = summarizePaymentHistory({ shown: 300, rowCount: 250, count: 250 });
    expect(s.total).toBe(250);
    expect(s.visible).toBe(250);
    expect(s.remaining).toBe(0);
    expect(s.hasMore).toBe(false);
    expect(s.capped).toBe(false);
    expect(s.caption).toBe("Showing all 250 payments.");
    expect(paymentHistoryControls(s)).toBeNull();
  });

  it("count 2,431 at the cap — capped caption names where the rest live, no buttons", () => {
    const s = summarizePaymentHistory({
      shown: 2000,
      rowCount: 2000,
      count: 2431,
    });
    expect(s.total).toBe(2431);
    expect(s.visible).toBe(2000);
    expect(s.remaining).toBe(431);
    expect(s.capped).toBe(true);
    expect(s.hasMore).toBe(false);
    expect(s.nextShown).toBe(2000);
    expect(s.caption).toBe(
      "Showing the 2,000 most recent of 2,431 payments. Older ones are on each coach's page and in Reports → Payments.",
    );
    expect(paymentHistoryControls(s)).toBeNull();
  });

  it("count exactly 2,000 at the cap — all shown, NOT capped", () => {
    const s = summarizePaymentHistory({
      shown: 2000,
      rowCount: 2000,
      count: 2000,
    });
    expect(s.capped).toBe(false);
    expect(s.hasMore).toBe(false);
    expect(s.caption).toBe("Showing all 2,000 payments.");
  });

  it("rowCount 101 with count 100 — the count lagged a write: total 101, never '101 of 100'", () => {
    const s = summarizePaymentHistory({ shown: 200, rowCount: 101, count: 100 });
    expect(s.total).toBe(101);
    expect(s.visible).toBe(101);
    expect(s.remaining).toBe(0);
    expect(s.hasMore).toBe(false);
    expect(s.capped).toBe(false);
    expect(s.caption).toBe("Showing all 101 payments.");
    expect(s.caption).not.toContain("of 100");
    expect(paymentHistoryControls(s)).toBeNull();
  });

  it("the step never carries nextShown past the cap", () => {
    const s = summarizePaymentHistory({
      shown: 1950,
      rowCount: 1950,
      count: 2431,
    });
    expect(s.nextShown).toBe(2000);
    expect(s.hasMore).toBe(true);
    expect(s.capped).toBe(false);
    // Only 50 more rows can appear before the cap, so the button says 50.
    expect(moreButtonCount(s)).toBe(50);
    expect(paymentHistoryControls(s)?.more.label).toBe("Show 50 more");
  });

  it("formats large counts with thousands separators in the buttons too", () => {
    const s = summarizePaymentHistory({
      shown: 100,
      rowCount: 100,
      count: 1234,
    });
    expect(s.caption).toBe("Showing the 100 most recent of 1,234 payments.");
    expect(paymentHistoryControls(s)?.all).toEqual({
      shown: 2000,
      label: "Show all (1,234)",
      ariaLabel: "Show all 1,234 payments",
    });
  });
});

describe("paymentHistoryHref", () => {
  it("the default step is the bare path, so the canonical URL stays clean", () => {
    expect(paymentHistoryHref(100)).toBe("/admin/payments");
  });

  it("anything else carries ?shown=", () => {
    expect(paymentHistoryHref(200)).toBe("/admin/payments?shown=200");
    expect(paymentHistoryHref(250)).toBe("/admin/payments?shown=250");
    expect(paymentHistoryHref(PAYMENT_HISTORY_CAP)).toBe(
      "/admin/payments?shown=2000",
    );
  });

  it("round-trips through normalizeShown", () => {
    for (const shown of [100, 200, 250, 2000]) {
      const query = paymentHistoryHref(shown).split("?shown=")[1];
      expect(normalizeShown(query)).toBe(shown);
    }
  });
});
