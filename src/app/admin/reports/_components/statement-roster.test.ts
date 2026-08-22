// payment-statement SPEC §8.1 — THE ROLL-UP IS THE WIDEST MONEY SURFACE IN THIS
// APP, and two of its four columns shipped able to mislead.
//
// Asserted by rendering the real component to static markup rather than by
// testing a helper: both defects were entirely in what reached the page (a
// column LABEL that collided with a different figure, and two glance stats that
// dropped rows whose sign had flipped). A helper test would have stayed green
// through both.
//
// ── The two defects ─────────────────────────────────────────────────────────
//
// 🔴 (1) "Payments with no period stated" named THREE different numbers.
// `engine.ts` sums both directions into `unappliedCents`
// (`cage.unappliedCents + work.unappliedCents`), while each statement shows its
// own account's figure. So Alex Milone read $210 here, $170 on the cage
// statement and $40 on the work statement — the same six words over three
// values, one click apart. It is also the only figure in this feature that adds
// `coach_to_pfa` and `pfa_to_coach` money together, and SPEC §11's rule is "no
// combined total anywhere" — legitimate here ONLY because it is a count of
// money that needs a date rather than a balance, which is exactly what the
// label has to say.
//
// 🔴 (2) The glance stats read `cageBalanceCents > 0` and `workBalanceCents > 0`
// and nothing else. SPEC §11 says Mark pays coaches outside the app and this
// feature exists to make him record it — so an overpaid work account is a real
// case, and `workBalanceCents = −4000` rendered `($40.00)` under a header
// reading "PFA owes coach" while the coach appeared in NEITHER stat. The
// footnote explained parentheses for the CAGE column only, so the most
// available reading of that cell was "PFA owes $40" — i.e. pay him again.
// `engine.ts`'s `directionLabel` already flips with the sign on the single-coach
// card; the roll-up must not contradict the document it links to.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatementRoster } from "./statement-roster";
import type { StatementRosterEntry } from "@/lib/statement/types";

function entry(over: Partial<StatementRosterEntry> = {}): StatementRosterEntry {
  return {
    coachId: "alex",
    coachName: "Alex Milone",
    cageBalanceCents: 0,
    workBalanceCents: 0,
    unappliedCents: 0,
    ...over,
  };
}

function render(rows: StatementRosterEntry[]): string {
  return renderToStaticMarkup(
    createElement(StatementRoster, {
      rows,
      periodLabel: "Jul 1 – Jul 31, 2026",
      hrefForCoach: (id: string) => `/admin/reports?tab=statements&coachIds=${id}`,
    }),
  );
}

/** The glance stats, as `label → printed value`, read off the rendered page. */
function stats(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(
    /<dt\b[^>]*>(.*?)<\/dt><dd\b[^>]*>(.*?)<\/dd>/g,
  )) {
    out[text(m[1])] = text(m[2]);
  }
  return out;
}

/** Everything below the table — the reconciling footnote. */
function footnote(html: string): string {
  const start = html.indexOf("<p ", html.lastIndexOf("</table>"));
  return text(html.slice(start));
}

/** The column headers, as printed text. */
function headers(html: string): string[] {
  return [...html.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]));
}

/** The whole page as plain text, for label-collision checks. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/<!--.*?-->/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&rsquo;|&#x27;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/* ── (1) The untagged column must not borrow the statement's words ────────── */

describe("🔴 the untagged-payments column does not collide with the statement's line", () => {
  const ALEX = [entry({ unappliedCents: 21_000 })];

  it("does NOT reuse the statement's phrase as a column header", () => {
    // The statement's own NOT-INCLUDED block prints "Payments with no period
    // stated" for ONE account. This table's figure is both directions summed,
    // so wearing the same words makes two different numbers look like one.
    // (The footnote may still QUOTE that phrase — reconciling the two is its
    // job. What must not happen is the two figures sharing a label.)
    for (const header of headers(render(ALEX))) {
      expect(header).not.toContain("Payments with no period stated");
    }
  });

  it("names the column so it cannot be read as a per-account figure", () => {
    const columns = headers(render(ALEX)).join(" | ");
    expect(columns).toContain("Untagged payments");
    // Scope stated ON THE COLUMN, not only in the footnote — a printed roster
    // is read without the app around it, and a screenshotted row loses both.
    expect(columns).toContain("both directions");
    expect(columns).toContain("all time");
  });

  it("the glance stat is labelled the same way, and says it spans coaches", () => {
    const s = stats(render([...ALEX, entry({ coachId: "b", coachName: "Bo", unappliedCents: 4_000 })]));
    // 21,000 + 4,000. Summed AGAIN across coaches, so it is a third scope
    // beyond the column's and the statement's.
    expect(s["Untagged payments"]).toBe("$250.00");
    expect(Object.keys(s)).not.toContain("Payments with no period stated");
  });

  it("the footnote says the figure is normally LARGER than a statement's", () => {
    const note = footnote(render(ALEX));
    expect(note).toMatch(/both directions/i);
    expect(note).toMatch(/larger/i);
    // And it must point at the statement's own line, or a reader has no way to
    // know the two are different figures rather than a contradiction.
    expect(note).toMatch(/no period stated/i);
  });
});

/* ── (2) Flipped signs, on both columns ──────────────────────────────────── */

describe("🔴 the glance stats account for a FLIPPED sign", () => {
  it("counts a coach PFA OVERPAID for work as owing PFA", () => {
    // The §11 case: Mark paid him outside the app, then recorded it, and the
    // recorded payout exceeds the logged work. He owes PFA $40.
    const s = stats(render([entry({ workBalanceCents: -4_000 })]));
    expect(s["Coaches owing PFA"]).toBe("1");
    expect(s["Coaches PFA owes"]).toBe("0");
  });

  it("counts a coach who PREPAID cage rent as one PFA owes", () => {
    // The mirror case, already covered by `Money`'s parentheses but by no stat:
    // a negative cage balance means PFA is holding his money.
    const s = stats(render([entry({ cageBalanceCents: -4_000 })]));
    expect(s["Coaches PFA owes"]).toBe("1");
    expect(s["Coaches owing PFA"]).toBe("0");
  });

  it("still counts the ordinary same-sign cases", () => {
    const s = stats(
      render([
        entry({ coachId: "a", coachName: "A", cageBalanceCents: 8_800 }),
        entry({ coachId: "b", coachName: "B", workBalanceCents: 66_000 }),
      ]),
    );
    expect(s["Coaches owing PFA"]).toBe("1");
    expect(s["Coaches PFA owes"]).toBe("1");
  });

  it("counts a coach with money running BOTH ways in both stats", () => {
    // The common real shape: he rents cages AND is owed for work. Both
    // sentences are true about him, and neither stat may swallow the other.
    const s = stats(
      render([entry({ cageBalanceCents: 8_800, workBalanceCents: 66_000 })]),
    );
    expect(s["Coaches owing PFA"]).toBe("1");
    expect(s["Coaches PFA owes"]).toBe("1");
  });

  it("leaves a fully square coach out of both stats", () => {
    const s = stats(render([entry({ unappliedCents: 500 })]));
    expect(s["Coaches owing PFA"]).toBe("0");
    expect(s["Coaches PFA owes"]).toBe("0");
  });

  it("🔴 between them, the two stats account for EVERY non-zero row", () => {
    // The property the shipped version broke: a coach could have a non-zero
    // balance in a column and appear nowhere in the summary above it.
    const rows = [
      // One-sided, each of the four sign/column combinations:
      entry({ coachId: "1", coachName: "One", cageBalanceCents: 8_800 }),
      entry({ coachId: "2", coachName: "Two", cageBalanceCents: -8_800 }),
      entry({ coachId: "3", coachName: "Three", workBalanceCents: 66_000 }),
      entry({ coachId: "4", coachName: "Four", workBalanceCents: -4_000 }),
      // Genuinely BOTH: rents cages and is owed for work (the common shape) …
      entry({ coachId: "5", coachName: "Five", cageBalanceCents: 100, workBalanceCents: 100 }),
      // … and its mirror: prepaid cage rent and was overpaid for work.
      entry({ coachId: "6", coachName: "Six", cageBalanceCents: -100, workBalanceCents: -100 }),
      // Square in both — belongs in neither.
      entry({ coachId: "7", coachName: "Seven" }),
    ];
    const s = stats(render(rows));
    const owing = Number(s["Coaches owing PFA"]);
    const owed = Number(s["Coaches PFA owes"]);

    // 1 (cage due), 4 (work overpaid), 5, 6.
    expect(owing).toBe(4);
    // 2 (cage ahead), 3 (work due), 5, 6.
    expect(owed).toBe(4);

    // COVERAGE, which is the property the shipped version broke: every row with
    // a non-zero balance is named by at least one of the two stats. The counts
    // overlap (rows 5 and 6 are in both) and are deliberately not a partition —
    // splitting them would need a combined total to decide which side a
    // two-way coach belongs on, and there is no such figure (SPEC §11).
    const named = rows.filter(
      (r) =>
        r.cageBalanceCents > 0 ||
        r.workBalanceCents < 0 ||
        r.workBalanceCents > 0 ||
        r.cageBalanceCents < 0,
    );
    const nonZero = rows.filter(
      (r) => r.cageBalanceCents !== 0 || r.workBalanceCents !== 0,
    );
    expect(named.map((r) => r.coachId)).toEqual(nonZero.map((r) => r.coachId));
    expect(nonZero).toHaveLength(6);
    expect(owing + owed - 2).toBe(nonZero.length);
  });
});

describe("🔴 the footnote gives a parentheses rule for BOTH columns", () => {
  const HTML = render([
    entry({ cageBalanceCents: -4_000, workBalanceCents: -4_000 }),
  ]);

  it("says what parentheses mean in the CAGE column, by who owes whom", () => {
    const note = footnote(HTML);
    expect(note).toMatch(/cage/i);
    expect(note).toMatch(/PFA owes/i);
  });

  it("says what parentheses mean in the WORK column, by who owes whom", () => {
    // The dangerous half: under a header reading "PFA owes coach", ($40.00)
    // means the COACH owes PFA. Nothing on the shipped page said so.
    const note = footnote(HTML);
    expect(note).toMatch(/work pay/i);
    expect(note).toMatch(/owes PFA/i);
  });

  it("does not explain parentheses as a bare 'credit' and stop there", () => {
    // "credit" is the statement's word for one account's own overpayment; on a
    // two-direction table it does not say which way the money runs.
    const note = footnote(HTML);
    expect(note).toMatch(/other way|opposite direction|runs the other/i);
  });
});

// SPEC §11 on the roll-up — nothing held this sentence in place until now. It
// was rewritten 2026-08-12 and the OLD copy would have been just as green,
// because no test looked at it at all.
describe("the payout caveat", () => {
  /**
   * The caveat block ALONE — between the glance stats and the table.
   *
   * Block-scoped on purpose. The words "work pay" and "payouts" both appear in
   * the column headers and the footnote, so a whole-page grep for this sentence
   * would pass on a page that had dropped it entirely.
   */
  function caveat(html: string): string {
    const start = html.indexOf("</dl>");
    const end = html.indexOf("print-flow", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return text(html.slice(start, end));
  }

  const HTML = render([entry()]);

  it("DEFINES work pay as net of the payouts recorded in the app", () => {
    // Says what the number IS. "recorded here" is the load-bearing half: it
    // bounds the subtraction in the same breath as the definition, so a payout
    // that was never entered is visibly outside it.
    // `['’]` because the source writes `&rsquo;` but React renders it as the
    // literal curly character, which the shared `text()` helper only maps back
    // when it arrives in entity form. An assertion on printed copy should not
    // care which apostrophe the renderer chose.
    expect(caveat(HTML)).toMatch(
      /work pay is the logged work['’]s value, plus any stipends earned, minus the payouts recorded here/i,
    );
  });

  it("🔴 NAMES STIPENDS, because this column now sums two different kinds of pay", () => {
    // The regression: the copy used to define the column as "the logged work's
    // value" alone. A stipend is NOT logged work — it is a flat half-month
    // amount owed whatever the hours say — so once stipends could land in this
    // column, that definition described only half the number beside it.
    // Same defect the 2026-08-12 rewrite fixed, reached from a new direction.
    expect(caveat(HTML)).toMatch(/stipend/i);
  });

  it("does not claim outside payouts are simply never subtracted", () => {
    // 🔴 THE REGRESSION THIS EXISTS TO CATCH. The original copy read "PFA pays
    // coaches outside this system, so any payout that was never recorded here
    // is not subtracted" — true when prod held ONE payment row, false once 17
    // payouts totalling $18,597.50 were recorded on 2026-08-03. Over-warning
    // about a number that has become trustworthy is how a reader learns to skip
    // the warning, which costs on the day it matters.
    const block = caveat(HTML);
    expect(block).not.toMatch(/is not subtracted/i);
    expect(block).not.toMatch(/outside this system/i);
  });
});
