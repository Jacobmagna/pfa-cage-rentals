// payment-statement SPEC §2, §5 — WHAT REACHES THE PAGE.
//
// Four review findings, all of them in the RENDERING rather than the arithmetic,
// which is why they are asserted by rendering the real component to static
// markup. Every one of them was invisible to a green engine suite.
//
//  · §5.3 / §2 rule 1 — the charge table had NO Slots column, so an off-slot
//    cage booking printed a row whose only available arithmetic (wall-clock
//    minutes × the rate) came out about HALF the amount charged.
//  · §2 rule 2 — the two headline balances sat ABOVE the switcher, the chips and
//    the masthead that states the period, so the screen opened with "Work pay ·
//    PFA owes Alex Milone · $660.00" and no date anywhere near it.
//  · §5.3 — a PENDING UNTAGGED payment reached no figure and no row, though
//    /admin/payments showed it. "Mark recording a payment and not seeing it on
//    the statement is a support call."
//  · the payments empty state was keyed on the SETTLED rows, so a period with
//    only pending payments printed "No payments covering this period have been
//    recorded." directly above a Pending block listing them.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatementCard } from "./statement-card";
import type {
  Statement,
  StatementChargeRow,
  StatementPaymentRow,
} from "@/lib/statement/types";

function statement(over: Partial<Statement> = {}): Statement {
  return {
    account: "cage",
    directionLabel: "Alex Milone owes PFA",
    openingLabel: "Previous balance (as of Jun 30)",
    closingLabel: "Statement balance as of Jul 31",
    openingCents: 0,
    chargesCents: 0,
    paymentsCents: 0,
    closingCents: 0,
    chargeLines: [],
    chargeRows: [],
    paymentRows: [],
    unappliedCents: 0,
    chargesAfterCents: 0,
    paymentsCoveringAfterCents: 0,
    currentBalanceCents: 0,
    caveat: null,
    scopeNote: null,
    ...over,
  };
}

function chargeRow(over: Partial<StatementChargeRow> = {}): StatementChargeRow {
  return {
    date: "Jul 03",
    dayOfWeek: "Fri",
    timeRange: "9:14 – 10:01 AM",
    description: "Cage 2",
    rateLabel: "$22.00 /30 min",
    slots: 3,
    amountCents: 6_600,
    ...over,
  };
}

function paymentRow(
  over: Partial<StatementPaymentRow> = {},
): StatementPaymentRow {
  return {
    paidOn: "Aug 07",
    method: "Zelle",
    reference: "July 2026",
    coversThrough: "Jul 31",
    amountCents: 66_000,
    pending: false,
    ...over,
  };
}

function render(
  cage: Statement,
  work: Statement = statement({ account: "work", directionLabel: "PFA owes Alex Milone" }),
  account: "cage" | "work" = "cage",
): string {
  return renderToStaticMarkup(
    createElement(StatementCard, {
      pair: {
        coachName: "Alex Milone",
        coachEmail: "alexmilone@example.com",
        periodLabel: "Jul 1 – Jul 31, 2026",
        periodEndShort: "Jul 31",
        cage,
        work,
      },
      account,
      hrefForAccount: (a) => `/admin/reports?tab=statements&account=${a}`,
    }),
  );
}

function text(html: string): string {
  return html
    .replace(/<!--.*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#x27;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&ndash;|&#x2013;/g, "–")
    .replace(/\s+/g, " ")
    .trim();
}

/** The charge-detail table's header cells, in printed order. */
function chargeHeaders(html: string): string[] {
  const table = html.slice(html.indexOf("Charges this period"));
  const head = table.slice(0, table.indexOf("</thead>"));
  return [...head.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]));
}

/** One charge-detail body row's cells, as printed text. */
function chargeCells(html: string): string[] {
  const table = html.slice(html.indexOf("Charges this period"));
  const body = table.slice(table.indexOf("<tbody>"), table.indexOf("</tbody>"));
  return [...body.matchAll(/<td\b[^>]*>(.*?)<\/td>/g)].map((m) => text(m[1]));
}

/* ── SPEC §5.3 / §2 rule 1 — the charge row multiplies out on the page ────── */

describe("🔴 the printed charge table carries the Slots column", () => {
  const CAGE = statement({
    chargesCents: 6_600,
    closingCents: 6_600,
    currentBalanceCents: 6_600,
    chargeLines: [{ label: "Cage", units: "3 slots · 1.5 h", amountCents: 6_600 }],
    chargeRows: [chargeRow()],
  });

  it("prints a Slots header, in the Cage Detail column order", () => {
    // /admin/reports' Detail table is Date · Day · Start · End · Resource ·
    // Coach · Slots · Rate · $ — SPEC §5.3 says reuse that column set, so Slots
    // sits between the description and the rate here too.
    expect(chargeHeaders(render(CAGE))).toEqual([
      "Date",
      "Day",
      "Time",
      "Description",
      "Slots",
      "Rate",
      "Amount",
    ]);
  });

  it("🔴 an OFF-SLOT row can be multiplied out by a reader", () => {
    // 9:14 – 10:01 is 47 minutes of wall clock and bills 3 slots. Without the
    // slot count the only sum available was 47 min × the rate, which is about
    // half of $66.00 — the coach's conclusion being that he was double-charged.
    const cells = chargeCells(render(CAGE));
    expect(cells).toEqual([
      "Jul 03",
      "Fri",
      "9:14 – 10:01 AM",
      "Cage 2",
      "3",
      "$22.00 /30 min",
      "$66.00",
    ]);
    // …and the arithmetic those cells support gives the amount printed beside
    // them: 3 slots × $22.00 = $66.00.
    expect(3 * 2_200).toBe(6_600);
  });

  it("states the one fact the column needs: a slot is 30 minutes, billed whole", () => {
    const page = text(render(CAGE));
    expect(page).toMatch(/slot is 30 minutes/i);
    expect(page).toMatch(/whole slots/i);
    // The docstring case, so the explainer is verifiable against the row above.
    expect(page).toContain("9:14 – 10:01");
  });

  it("omits the Slots column on the WORK account, which has no slot model", () => {
    // Program pay is per-hour × exact duration or a flat per-session rate. A
    // column of dashes there would invent a unit that ledger never charges in.
    const work = statement({
      account: "work",
      directionLabel: "PFA owes Alex Milone",
      chargesCents: 2_250,
      chargeLines: [{ label: "HS Summer Program", units: "0.75 h", amountCents: 2_250 }],
      chargeRows: [
        chargeRow({
          description: "HS Summer Program",
          rateLabel: "$30.00/hr",
          slots: null,
          amountCents: 2_250,
        }),
      ],
    });
    const html = render(statement(), work, "work");
    expect(chargeHeaders(html)).not.toContain("Slots");
    expect(text(html)).not.toMatch(/slot is 30 minutes/i);
  });
});

/* ── SPEC §2 rule 2 — one period, stated once, AT THE TOP ────────────────── */

describe("🔴 the period is stated above the two headline balances", () => {
  const WORK = statement({
    account: "work",
    directionLabel: "PFA owes Alex Milone",
    closingCents: 66_000,
    currentBalanceCents: 66_000,
  });

  it("prints the period before either balance figure", () => {
    const page = text(render(statement(), WORK, "work"));
    const period = page.indexOf("Jul 1 – Jul 31, 2026");
    const firstBalance = page.indexOf("$660.00");
    expect(period).toBeGreaterThanOrEqual(0);
    expect(firstBalance).toBeGreaterThanOrEqual(0);
    // The masthead states the period too, but that is BELOW the switcher and
    // the chips — so the first mention has to come before the first figure.
    expect(period).toBeLessThan(firstBalance);
  });

  it("qualifies EACH balance cell with an as-of date", () => {
    // Belt and braces on purpose: the line above can scroll away or be cropped
    // out of a screenshot, and a payout figure with no date on it is §11's most
    // expensive mistake.
    const html = render(statement(), WORK, "work");
    // The TOP block only — the printed masthead has its own Direction cell,
    // which is beside the period line already and is not a balance.
    const top = html.slice(0, html.indexOf("PFA · "));
    const cells = [...top.matchAll(/<dd\b[^>]*>(.*?)<\/dd>/g)].map((m) => text(m[1]));
    const balanceCells = cells.filter((c) => c.includes("owes"));
    expect(balanceCells).toHaveLength(2);
    for (const cell of balanceCells) {
      expect(cell).toContain("as of Jul 31");
    }
  });

  it("says the period once in the top block, not twice", () => {
    // SPEC §2 rule 2 — "one period, stated ONCE, at the top". The masthead's
    // copy is the document's; this block must not add a second spelling.
    const html = render(statement(), WORK, "work");
    const top = html.slice(0, html.indexOf("PFA · "));
    const mentions = text(top).match(/Jul 1 – Jul 31, 2026/g) ?? [];
    expect(mentions).toHaveLength(1);
  });
});

/* ── SPEC §5.3 — pending, untagged, and the empty state that contradicted it ─ */

describe("🔴 a period with ONLY pending payments does not claim to have none", () => {
  const ONLY_PENDING = statement({
    chargesCents: 40_000,
    closingCents: 40_000,
    currentBalanceCents: 40_000,
    paymentRows: [
      paymentRow({ pending: true, amountCents: 12_000, method: "Check", reference: "#1042" }),
    ],
  });

  it("does not print 'no payments … have been recorded' above a pending list", () => {
    const page = text(render(ONLY_PENDING));
    expect(page).not.toContain(
      "No payments covering this period have been recorded",
    );
    // …and it still lists the pending payment, so nothing was traded away.
    expect(page).toContain("$120.00");
    expect(page).toContain("Pending — not included in the balance above");
  });

  it("says the true thing instead: nothing CONFIRMED, see pending", () => {
    const page = text(render(ONLY_PENDING));
    expect(page).toMatch(/no confirmed payments covering this period/i);
    expect(page).toMatch(/not counted in the balance/i);
  });

  it("keeps the plain empty state when there is genuinely nothing", () => {
    const page = text(render(statement()));
    expect(page).toContain(
      "No payments covering this period have been recorded",
    );
    expect(page).not.toContain("Pending — not included in the balance above");
  });
});

describe("🔴 a PENDING UNTAGGED payment is visible on the document", () => {
  const UNTAGGED_PENDING = statement({
    paymentRows: [
      paymentRow({
        pending: true,
        coversThrough: null,
        amountCents: 9_900,
        method: "Check",
        reference: "#1042",
      }),
    ],
  });

  /**
   * The PENDING block only.
   *
   * ⚠️ Scoped deliberately: the reconciliation block lower down already says
   * "Payments with no period stated" and "counted in no period at all", so a
   * whole-page substring check passes even when the pending row renders nothing
   * at all. That false green is exactly the shape of the defect being fixed.
   */
  function pendingBlock(html: string): string {
    const start = html.indexOf("Pending — not included");
    return text(html.slice(start, html.indexOf("</div>", start)));
  }

  it("renders in the pending block and SAYS it states no period", () => {
    const block = pendingBlock(render(UNTAGGED_PENDING));
    expect(block).toContain("$99.00");
    expect(block).toContain("no period stated");
  });

  it("explains, in that block, why it is here and what to do with it", () => {
    // He has TWO things to fix on this row (confirm it, and date it), which is
    // exactly why it must not be the row that quietly disappears.
    const block = pendingBlock(render(UNTAGGED_PENDING));
    expect(block).toMatch(/counted in no period/i);
    expect(block).toMatch(/covers through/i);
  });

  it("says nothing about a coverage period when a pending row HAS one", () => {
    // The note is conditional, so a normal pending payment is unaffected.
    const block = pendingBlock(render(statement({ paymentRows: [paymentRow({ pending: true })] })));
    expect(block).toContain("covers through Jul 31");
    expect(block).not.toMatch(/no period stated/i);
  });

  it("does not print a 'covers through' phrase for it as if it had one", () => {
    const html = render(UNTAGGED_PENDING);
    const block = html.slice(html.indexOf("Pending — not included"));
    const list = block.slice(block.indexOf("<ul"), block.indexOf("</ul>"));
    expect(text(list)).not.toMatch(/· covers through/);
    expect(text(list)).toMatch(/· no period stated/);
  });
});
