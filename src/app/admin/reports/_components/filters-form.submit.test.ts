// 🔴 payment-statement SPEC §10 / §13 Phase C — THE THING THIS PHASE CAN BREAK.
//
// `filters-form.tsx` is shared by all FOUR tabs and its GET action feeds the
// same `filters.ts` the DOWNLOAD route parses. The Statements work replaced the
// form's hidden `<input name="tab">` with `name="tab"` on both submit buttons,
// because only the CLICKED button's name/value is submitted — that is what lets
// "See statement for this period" jump tabs while "Apply filters" stays put,
// with no JS. It is also a change that could silently send Cage, Work or
// Payments back to the default tab on every Apply, or submit `tab` twice (and
// `normalizeReportTab` takes the FIRST value, so a duplicate would be a
// wrong-tab bug that looks like nothing).
//
// So this asserts the rendered form, per tab, rather than eyeballing it:
//   · Apply filters carries THIS tab.
//   · See statement carries "statements", from every tab.
//   · There is no hidden `tab` input left behind — both together would submit
//     the key twice.
//   · The form still GETs /admin/reports.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { filtersToQueryString, normalizeFilters } from "@/lib/reports/filters";
import { REPORT_TABS, type ReportTab } from "@/lib/reports/tabs";
import type { StatementAccount } from "@/lib/statement/types";
import { FiltersForm } from "./filters-form";

function markup(activeTab: ReportTab, account: StatementAccount = "cage"): string {
  return renderToStaticMarkup(
    createElement(FiltersForm, {
      coaches: [{ id: "coach-a", name: "Alex Milone", email: "a@pfa.test" }],
      programs: [{ id: "prog-1", name: "HS Summer Program" }],
      activeTab,
      account,
      values: {
        from: "2026-07-01",
        to: "2026-07-31",
        coachIds: [],
        resourceTypes: [],
        programId: "",
      },
    }),
  );
}

/** Every `name="tab"` field in the form, submit buttons and inputs alike. */
function tabFields(html: string): { tag: string; value: string }[] {
  const found: { tag: string; value: string }[] = [];
  for (const match of html.matchAll(/<(button|input)\b[^>]*>/g)) {
    const el = match[0];
    if (!/\bname="tab"/.test(el)) continue;
    found.push({
      tag: match[1],
      value: /\bvalue="([^"]*)"/.exec(el)?.[1] ?? "",
    });
  }
  return found;
}

describe("FiltersForm — Apply filters lands each tab on ITSELF", () => {
  it.each(REPORT_TABS)("stays on %s", (tab) => {
    const fields = tabFields(markup(tab));
    // Exactly two: Apply (this tab) and See statement (statements). A third
    // would be the hidden input coming back.
    expect(fields).toHaveLength(2);
    expect(fields[0]).toEqual({ tag: "button", value: tab });
  });

  it("offers See statement from every tab", () => {
    for (const tab of REPORT_TABS) {
      const fields = tabFields(markup(tab));
      expect(fields[1]).toEqual({ tag: "button", value: "statements" });
    }
  });

  it("carries the tab on SUBMIT BUTTONS, never a hidden input", () => {
    // A GET submit rebuilds the query string from the form's fields alone. Both
    // a hidden input AND a named button would emit `tab` twice.
    for (const tab of REPORT_TABS) {
      const html = markup(tab);
      expect(html).not.toMatch(/<input[^>]*type="hidden"[^>]*name="tab"/);
      expect(html).not.toMatch(/<input[^>]*name="tab"/);
      expect(tabFields(html).every((f) => f.tag === "button")).toBe(true);
    }
  });

  it("both tab-carrying fields are real submit buttons", () => {
    const html = markup("cage");
    const submits = [...html.matchAll(/<button\b[^>]*>/g)].filter((m) =>
      /\btype="submit"/.test(m[0]),
    );
    expect(submits).toHaveLength(2);
    expect(submits.every((m) => /\bname="tab"/.test(m[0]))).toBe(true);
  });

  it("still GETs /admin/reports", () => {
    // The download route and the page share this filter contract; a changed
    // action or method would break both at once.
    const html = markup("statements");
    expect(html).toMatch(/<form[^>]*method="get"[^>]*>/i);
    expect(html).toMatch(/<form[^>]*action="\/admin\/reports"[^>]*>/);
  });

  /* ── 🔴 `account` is VIEW STATE, and view state must survive an Apply. ──── */
  //
  // This block previously asserted the OPPOSITE — "emits no `account` field, the
  // switcher is not a filter" — and it was wrong, because it conflated two
  // different claims:
  //
  //   · `account` never reaches `NormalizedFilters` / `filtersToQueryString`
  //     — TRUE, load-bearing, and still asserted below. It selects which of two
  //     already-computed statements is displayed and must never narrow a query,
  //     a workbook sheet, or a download.
  //   · `account` is not preserved through a submit — FALSE, and a real defect.
  //
  // A GET submit rebuilds the query string from the form's fields ALONE, so with
  // no `account` field the param was dropped: reading a coach's WORK PAY
  // statement, adjusting the dates and pressing Apply landed on CAGE RENTALS —
  // an unrequested DIRECTION change on a money document, silently, from a button
  // labelled "Apply filters". `statementHref` already preserves `account` for
  // the chips and the roster links; only the Apply path lost it.
  //
  // A hidden input is the right shape and not a shortcut: it preserves view
  // state exactly as the submit buttons' `name="tab"` does, WITHOUT entering the
  // filter object. `tab` needs to be on the buttons because the two buttons
  // disagree about it; `account` is the same for both, so one hidden input
  // cannot submit a duplicate.

  it("carries `account` through the submit, as a hidden input", () => {
    for (const tab of REPORT_TABS) {
      const html = markup(tab, "work");
      expect(html).toMatch(
        /<input[^>]*type="hidden"[^>]*name="account"[^>]*value="work"|<input[^>]*name="account"[^>]*value="work"[^>]*>/,
      );
    }
  });

  it("carries whichever account is on screen", () => {
    expect(markup("statements", "cage")).toMatch(
      /name="account"[^>]*value="cage"|value="cage"[^>]*name="account"/,
    );
    expect(markup("statements", "work")).toMatch(
      /name="account"[^>]*value="work"|value="work"[^>]*name="account"/,
    );
  });

  it("emits `account` EXACTLY ONCE — never on a submit button too", () => {
    // Both a hidden input and a named button would submit the key twice, and
    // `normalizeStatementAccount` takes the FIRST value — a wrong-direction bug
    // that looks like nothing. This is the same trap the `tab` swap documents.
    for (const tab of REPORT_TABS) {
      const html = markup(tab, "work");
      const fields = [...html.matchAll(/<(button|input)\b[^>]*>/g)].filter((m) =>
        /\bname="account"/.test(m[0]),
      );
      expect(fields).toHaveLength(1);
      expect(fields[0][1]).toBe("input");
    }
  });

  it("🔴 `account` still never reaches NormalizedFilters or the query builder", () => {
    // The genuine half of the assertion this block replaced. Preserving view
    // state through a submit and letting it narrow a query are different things,
    // and only the second one is forbidden.
    const filters = normalizeFilters({
      from: "2026-07-01",
      to: "2026-07-31",
      // @ts-expect-error `account` is deliberately absent from RawFilterInput —
      // the type is the guarantee, this asserts the runtime agrees.
      account: "work",
    });
    expect("account" in filters).toBe(false);
    expect(filtersToQueryString(filters)).not.toMatch(/account/);
  });
});
