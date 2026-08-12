// payment-statement SPEC §5.2 — AN OVERPAID ACCOUNT MUST NOT LOOK LIKE AN
// OWED ONE.
//
// The engine keeps cents SIGNED and flips `directionLabel` when a closing
// balance goes negative, so the *sentence* is already right ("PFA owes Alex
// Milone"). The card, though, renders `Math.abs(...)` in FOUR places, and THREE
// of them shipped with no credit marker at all — which means a $40.00 credit
// and a $40.00 debt rendered as byte-identical money cells, distinguishable
// only by a direction sentence sitting in a different element. §5.2 requires
// BOTH: "$40.00 credit" AND the direction stated.
//
// This is asserted by rendering the real component to static markup rather
// than by testing a helper, because the defect was never in the arithmetic —
// it was in what reached the page. A helper test would have stayed green
// through the entire bug.
//
// 🔴 PROVEN RED FIRST (SPEC §12.8): before the fix, the two regexes below
// failed and the arithmetic block's existing badge passed — which is exactly
// the inconsistency inside one document that this file pins.
//
// ── The second pass (Jacob, after review) ────────────────────────────────────
// The first pass fixed the two HEADER-side cells and left `Line` alone, which
// was the wrong place to stop: `Line` renders "Previous balance (as of …)", the
// statement's FIRST line, and the reconciliation block's restated closing
// balance. Both are signed balances that can legitimately be negative (a coach
// who prepaid in June opens July at −$40), and both printed a bare figure —
// asserting the coach OWED $40 when he was $40 in credit.
//
// 🔴 That was not merely a missing label: it broke the column's arithmetic ON
// THE PAGE (SPEC §2 rule 1). The reader added `40.00 + charges − payments` and
// the total underneath said "$40.00 credit" — the sign appearing out of nowhere
// at the total line, which is the same class of defect commit 3d0f101 was made
// to fix, one line higher. `readsAsColumn` below is the regression test for
// that: it adds up what is PRINTED, the way a person would.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatementCard } from "./statement-card";
import type { Statement, StatementPair } from "@/lib/statement/types";

/**
 * The credit badge, as HTML. Matched IMMEDIATELY after the formatted amount so
 * the assertion proves the marker is attached to that money cell — a stray
 * "credit" anywhere on the page (there are several: "Payments & credits …")
 * would otherwise satisfy a naive substring check.
 *
 * The optional comment is React's text/element separator, which SSR emits in
 * some adjacency cases and not others; the test should not be pinned to that.
 */
function creditAfter(amount: string): RegExp {
  return new RegExp(
    `${amount.replace(/[$.]/g, "\\$&")}(<!-- -->)?<span[^>]*>credit</span>`,
  );
}

/** How many money cells carry the marker beside this exact amount. */
function creditCount(html: string, amount: string): number {
  return (
    html.match(new RegExp(creditAfter(amount).source, "g")) ?? []
  ).length;
}

function statement(
  account: "cage" | "work",
  closingCents: number,
  currentBalanceCents: number,
): Statement {
  return {
    account,
    // Whatever the sign, the engine has already made this sentence agree with
    // it — the card is only responsible for the marker beside the figure.
    directionLabel: closingCents < 0 ? "PFA owes Alex Milone" : "Alex Milone owes PFA",
    openingLabel: "Previous balance (as of Jun 30)",
    closingLabel: "Statement balance as of Jul 31",
    openingCents: 0,
    chargesCents: 0,
    paymentsCents: 0,
    closingCents,
    chargeLines: [],
    chargeRows: [],
    paymentRows: [],
    unappliedCents: 0,
    chargesAfterCents: 0,
    paymentsCoveringAfterCents: 0,
    currentBalanceCents,
    caveat: null,
    scopeNote: null,
  };
}

/** A statement with every figure settable, for the arithmetic-column tests. */
function full(overrides: Partial<Statement> = {}): Statement {
  return { ...statement("cage", 0, 0), ...overrides };
}

/* ── Reading the printed column the way a person would ────────────────────── */

type Cell = {
  /** The explicit operator printed to the left of the figure, if any. */
  op: "+" | "−" | null;
  /** Absolute cents, as printed. */
  cents: number;
  /** Whether the figure carries the credit marker. */
  credit: boolean;
};

/** Every money cell in one arithmetic panel, in printed order. */
function cells(block: string): Cell[] {
  return [...block.matchAll(/<dd\b[^>]*>(.*?)<\/dd>/g)].map((m) => {
    const body = m[1];
    const amount = /\$([\d,]+\.\d{2})/.exec(body);
    if (!amount) throw new Error(`no money in cell: ${body}`);
    return {
      op: (/>([+−])<\/span>/.exec(body)?.[1] ?? null) as Cell["op"],
      cents: Math.round(Number(amount[1].replace(/,/g, "")) * 100),
      credit: />credit<\/span>/.test(body),
    };
  });
}

function arithmeticPanel(html: string): string {
  const start = html.indexOf('<dl class="mt-5 max-w-md');
  return html.slice(start, html.indexOf("</dl>", start));
}

function reconciliationPanel(html: string): string {
  const start = html.indexOf("How this reconciles to today");
  return html.slice(start, html.indexOf("</dl>", start));
}

/**
 * Adds up a printed panel EXACTLY as a reader would, and returns both the sum
 * they arrive at and the total the page prints underneath.
 *
 * The reading rules are the document's own conventions, nothing more:
 *   · a figure with NO operator is a signed BALANCE — "credit" means negative
 *   · a figure WITH an operator is a magnitude, applied by that operator
 *   · the last row is the total
 *
 * SPEC §2 rule 1: "the arithmetic is visible and it ties out". If these two
 * numbers ever differ, the page is asking Mark to trust it instead of letting
 * him check it — which is the one thing a statement may not do.
 */
function readsAsColumn(panel: string): { sum: number; printedTotal: number } {
  const rows = cells(panel);
  const value = (c: Cell) => (c.credit ? -c.cents : c.cents);
  const total = rows[rows.length - 1];
  let sum = value(rows[0]);
  for (const row of rows.slice(1, -1)) {
    if (row.op === null) throw new Error("a middle row printed no operator");
    sum += (row.op === "+" ? 1 : -1) * value(row);
  }
  return { sum, printedTotal: value(total) };
}

function render(cage: Statement, work: Statement): string {
  const pair: StatementPair = {
    coachName: "Alex Milone",
    coachEmail: "alexmilone@example.com",
    periodLabel: "Jul 1 – Jul 31, 2026",
    periodEndShort: "Jul 31",
    cage,
    work,
  };
  return renderToStaticMarkup(
    createElement(StatementCard, {
      pair,
      account: "cage",
      hrefForAccount: (a) => `/admin/reports?tab=statements&account=${a}`,
    }),
  );
}

describe("StatementCard — a negative balance is marked as a CREDIT", () => {
  it("marks EVERY cell that prints the shown account's closing balance", () => {
    // -$40.00 on the cage account: Alex has paid ahead. That one figure is
    // printed THREE times — the header balance cell, the arithmetic panel's
    // bold total, and the reconciliation panel's restated opening line — so all
    // three have to agree about its direction. The count is what proves that;
    // asserting a single match would be satisfied by any one of them alone,
    // which is precisely the state this file was written to catch (it shipped
    // with one of the three marked).
    //
    // The CURRENT balance is deliberately positive so $40.00 can only come from
    // those three cells.
    const html = render(statement("cage", -4_000, 500), statement("work", 0, 0));
    expect(creditCount(html, "$40.00")).toBe(3);
  });

  it("marks the header balance cell for the OTHER account too", () => {
    // The header names BOTH balances (§5.0), so both cells need the marker —
    // the un-selected one is dimmed, not exempt.
    const html = render(
      statement("cage", 8_800, 8_800),
      statement("work", -6_600, -6_600),
    );
    expect(html).toMatch(creditAfter("$66.00"));
  });

  it("marks the CURRENT balance in the reconciliation block", () => {
    // A distinct amount from the closing balance, so the assertion cannot be
    // satisfied by the arithmetic block's already-shipped badge.
    const html = render(
      statement("cage", 8_800, -12_345),
      statement("work", 0, 0),
    );
    expect(html).toMatch(creditAfter("$123.45"));
  });

  it("leaves a POSITIVE balance unmarked", () => {
    // The marker must mean something. Everything positive stays bare, so the
    // presence of "credit" is itself the signal.
    const html = render(
      statement("cage", 8_800, 8_800),
      statement("work", 66_000, 66_000),
    );
    expect(html).not.toMatch(creditAfter("$88.00"));
    expect(html).not.toMatch(creditAfter("$660.00"));
  });

  it("uses ONE marker style, not a second one", () => {
    // §5.2 is satisfied by a consistent idiom, not by three inventions. All
    // three markers are the same badge, so the rendered class list is
    // identical everywhere it appears.
    const html = render(
      statement("cage", -4_000, -12_345),
      statement("work", -6_600, 0),
    );
    // Five negative money cells in this fixture: the two header balances, the
    // arithmetic panel's bold closing, the reconciliation panel's restated
    // closing, and the current balance.
    const badges = html.match(/<span[^>]*>credit<\/span>/g) ?? [];
    expect(badges).toHaveLength(5);
    expect(new Set(badges).size).toBe(1);
  });
});

/* ── The two BALANCE rows rendered by `Line` ──────────────────────────────── */

describe("🔴 a negative PREVIOUS balance — the statement's first line", () => {
  // A coach who prepaid in June opens July at −$40. Real, and not rare.
  const OVERPAID_OPENING = full({
    openingCents: -4_000,
    chargesCents: 66_000,
    paymentsCents: 66_000,
    closingCents: -4_000,
    currentBalanceCents: -4_000,
  });

  it("marks the previous-balance figure as a credit", () => {
    const html = render(OVERPAID_OPENING, statement("work", 0, 0));
    const panel = cells(arithmeticPanel(html));
    expect(panel[0].cents).toBe(4_000);
    expect(panel[0].credit).toBe(true);
  });

  it("prints no bare debit where a credit belongs", () => {
    // The precise wrong output: "$40.00" on the previous-balance line asserts
    // the coach OWED $40 at the start of the period. He was $40 ahead.
    const html = render(OVERPAID_OPENING, statement("work", 0, 0));
    const opening = cells(arithmeticPanel(html))[0];
    expect(opening.credit || opening.cents === 0).toBe(true);
  });

  it("marks the RESTATED closing balance in the reconciliation panel", () => {
    // Same figure as the arithmetic block's bold total, one panel lower, and it
    // went through `Line` instead — so it shipped bare while its twin two
    // inches above it carried a badge.
    const html = render(
      full({ closingCents: -4_000, currentBalanceCents: -4_000 }),
      statement("work", 0, 0),
    );
    const panel = cells(reconciliationPanel(html));
    expect(panel[0].cents).toBe(4_000);
    expect(panel[0].credit).toBe(true);
  });
});

describe("🔴 the printed column ADDS UP — SPEC §2 rule 1", () => {
  // Each case is read off the page and summed the way Mark would. The engine's
  // own identity (opening + charges − payments = closing) is unit-tested
  // separately; what is asserted here is that the RENDERING preserves it.
  const CASES: { name: string; statement: Statement }[] = [
    {
      name: "negative opening, negative closing",
      statement: full({
        openingCents: -4_000,
        chargesCents: 66_000,
        paymentsCents: 66_000,
        closingCents: -4_000,
      }),
    },
    {
      name: "negative opening that goes POSITIVE by the close",
      statement: full({
        openingCents: -4_000,
        chargesCents: 10_000,
        paymentsCents: 0,
        closingCents: 6_000,
      }),
    },
    {
      name: "positive opening that goes NEGATIVE by the close",
      statement: full({
        openingCents: 4_000,
        chargesCents: 0,
        paymentsCents: 8_000,
        closingCents: -4_000,
      }),
    },
    {
      name: "a plain owed period",
      statement: full({
        openingCents: 8_800,
        chargesCents: 66_000,
        paymentsCents: 0,
        closingCents: 74_800,
      }),
    },
    {
      name: "everything square",
      statement: full({
        openingCents: 0,
        chargesCents: 0,
        paymentsCents: 0,
        closingCents: 0,
      }),
    },
  ];

  it.each(CASES)("the arithmetic panel foots: $name", ({ statement: s }) => {
    const { sum, printedTotal } = readsAsColumn(
      arithmeticPanel(render(s, statement("work", 0, 0))),
    );
    expect(sum).toBe(printedTotal);
  });

  it("the reconciliation panel foots with a negative closing", () => {
    // closing −40 + after 44 − unapplied 10 = current −6.
    const s = full({
      closingCents: -4_000,
      chargesAfterCents: 4_400,
      paymentsCoveringAfterCents: 0,
      unappliedCents: 1_000,
      currentBalanceCents: -600,
    });
    const { sum, printedTotal } = readsAsColumn(
      reconciliationPanel(render(s, statement("work", 0, 0))),
    );
    expect(sum).toBe(-600);
    expect(printedTotal).toBe(-600);
  });

  it("the reconciliation panel foots with a payments-covering-after row too", () => {
    // The one conditionally-rendered row, so the parser sees five cells.
    const s = full({
      closingCents: -4_000,
      chargesAfterCents: 10_000,
      paymentsCoveringAfterCents: 2_000,
      unappliedCents: 1_000,
      currentBalanceCents: 3_000,
    });
    const panel = reconciliationPanel(render(s, statement("work", 0, 0)));
    expect(cells(panel)).toHaveLength(5);
    const { sum, printedTotal } = readsAsColumn(panel);
    expect(sum).toBe(3_000);
    expect(printedTotal).toBe(3_000);
  });
});

describe("the credit marker never collides with an operator", () => {
  // A row that printed BOTH a leading "−" and a "credit" badge would be a
  // double negative — "− $40.00 credit" reads as +$40 to anyone who parses it
  // carefully and as −$40 to everyone else. It must not be reachable.
  it("no cell carries both an operator and a credit badge", () => {
    const s = full({
      openingCents: -4_000,
      chargesCents: 66_000,
      paymentsCents: 70_000,
      closingCents: -8_000,
      chargesAfterCents: 4_400,
      paymentsCoveringAfterCents: 2_000,
      unappliedCents: 1_000,
      currentBalanceCents: -6_600,
    });
    const html = render(s, statement("work", -1_000, -1_000));
    for (const panel of [arithmeticPanel(html), reconciliationPanel(html)]) {
      for (const cell of cells(panel)) {
        expect(cell.op !== null && cell.credit).toBe(false);
      }
    }
  });

  it("the operator rows are the ones that cannot go negative", () => {
    // Charges, payments and unapplied are each a sum of non-negative amounts
    // (`amountCents` is `.positive()` in the payment schema; a charge is
    // slots × a non-negative rate). So every figure printed beside an operator
    // is a MAGNITUDE, and every signed BALANCE is printed without one — which
    // is exactly why the badge belongs on the operator-less rows only.
    const html = render(
      full({
        openingCents: -4_000,
        chargesCents: 66_000,
        paymentsCents: 66_000,
        closingCents: -4_000,
      }),
      statement("work", 0, 0),
    );
    const panel = cells(arithmeticPanel(html));
    expect(panel.map((c) => c.op)).toEqual([null, "+", "−", null]);
    expect(panel.map((c) => c.credit)).toEqual([true, false, false, true]);
  });
});
