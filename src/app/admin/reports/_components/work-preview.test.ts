// Work-hours tab rendering — the MONEY COLUMN, read the way a person reads it.
//
// 🔴 WHY THIS FILE EXISTS. The tab formatted money with a local
// `` `$${(cents / 100).toFixed(2)}` ``, which has no thousands separator. It
// printed "$2500.00" and a grand total of "$2580.00" while the printed
// statement, the coach's stipend card and the version history all printed
// "$2,500.00" — one number, two formats, one click apart, on the screen Mark
// runs payroll from.
//
// It was invisible until stipends arrived. Per-log pay rarely reaches four
// figures, so nothing on this screen had ever shown the gap. A half-month
// stipend is four figures every time AND it is the largest number on the page.
//
// Found by generating the real screen and reading it, not by an assertion —
// which is the same lesson this repo has now recorded nine times.

import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkPreview } from "./work-preview";
import type { WorkDetailRow, WorkSummaryRow } from "@/lib/reports/work-report";

const PERIOD_START = new Date("2026-08-16T07:00:00.000Z");
const PERIOD_END = new Date("2026-09-01T07:00:00.000Z");

function stipendRow(over: Partial<WorkDetailRow> = {}): WorkDetailRow {
  return {
    kind: "stipend",
    id: "earn-1",
    date: "2026-08-16",
    dayOfWeek: null,
    startTime: null,
    endTime: null,
    hours: 0,
    stipendCovered: false,
    periodLabel: "Aug 16–31, 2026",
    periodStart: PERIOD_START,
    periodEndExclusive: PERIOD_END,
    programName: "Stipend — Aug 16–31, 2026",
    coachId: "nick",
    coachName: "Nick Milone",
    coachEmail: "nick@example.com",
    ratePer30MinCents: null,
    perSessionRateCents: null,
    payCents: 250_000,
    note: null,
    scheduleNote: null,
    ...over,
  };
}

function summary(over: Partial<WorkSummaryRow> = {}): WorkSummaryRow {
  return {
    coachId: "nick",
    coachName: "Nick Milone",
    coachEmail: "nick@example.com",
    entries: 6,
    hours: 30,
    payCents: 258_000,
    ...over,
  } as WorkSummaryRow;
}

function render(detail: WorkDetailRow[], rows: WorkSummaryRow[]): string {
  return renderToStaticMarkup(
    createElement(WorkPreview, {
      detail,
      summary: rows,
      grandTotalCents: rows.reduce((t, r) => t + r.payCents, 0),
      grandTotalHours: rows.reduce((t, r) => t + r.hours, 0),
    } as never),
  );
}

describe("WorkPreview — money formatting", () => {
  it("🔴 prints four-figure money with a thousands separator", () => {
    const html = render([stipendRow()], [summary()]);
    expect(html).toContain("$2,500.00");
    expect(html).not.toContain("$2500.00");
  });

  it("🔴 the GRAND TOTAL too — it is the biggest number on the page", () => {
    const html = render([stipendRow()], [summary()]);
    expect(html).toContain("$2,580.00");
    expect(html).not.toContain("$2580.00");
  });

  it("still prints sub-thousand amounts unchanged", () => {
    const html = render(
      [stipendRow({ payCents: 8_000 })],
      [summary({ payCents: 8_000 })],
    );
    expect(html).toContain("$80.00");
  });
});
