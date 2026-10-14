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
import {
  buildWorkReport,
  type WorkDetailRow,
  type WorkReportInputRow,
  type WorkSummaryRow,
} from "@/lib/reports/work-report";
import type { StipendEarningRow } from "@/lib/stipend/fetch";

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
    // A stipend is never "on" or "off" a schedule (0q).
    unscheduled: false,
    reviewedOn: null,
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
    unscheduledCount: 0,
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

/* ── 0q RELEASE 1 — "Not on schedule" on the Work tab ───────────────────── */
//
// Sept 13 2026: the Work tab quoted $900 against $500–600 correct. Every
// over-paid row was a log whose schedule block had been deleted, and it
// rendered EXACTLY like a log that matched its block perfectly: both had a
// blank Schedule cell. These tests render the real tab from rows that went
// through `buildWorkReport` (rule 26 — enter at the top of the pipeline, not
// with a hand-built WorkDetailRow) and read each phrase INSIDE its own row
// (rule 7 — a phrase found elsewhere on the page proves nothing).
//
// 🔴 Every locator is anchored on HEADING TEXT and fails loudly naming the
// anchor it could not find (rule 11). Never a CSS class string.

// 2026-05-01 is PDT (UTC-7), so hour h PFA is h+7 UTC.
function pfa(hour: number): Date {
  return new Date(Date.UTC(2026, 4, 1, hour + 7, 0, 0, 0));
}
const STAMP = new Date("2026-05-02T18:00:00.000Z");

function logRow(over: Partial<WorkReportInputRow>): WorkReportInputRow {
  return {
    id: "log",
    coachId: "ana",
    coachName: "Ana Alvarez",
    coachEmail: "ana@example.com",
    createdBy: "ana",
    createdByName: "Ana Alvarez",
    createdByEmail: "ana@example.com",
    programId: "fall",
    programName: "BB - Fall Travelball - Game",
    startAt: pfa(9),
    endAt: pfa(10),
    note: null,
    scheduleNote: null,
    status: "posted",
    decisionReason: null,
    ratePer30MinCents: null,
    perSessionRateCents: 10_000,
    stipendCovered: false,
    unscheduled: false,
    reviewedAt: null,
    ...over,
  };
}

const BOB_STIPEND: StipendEarningRow = {
  id: "earn-bob",
  coachId: "bob",
  coachName: "Bob Bell",
  coachEmail: "bob@example.com",
  periodKey: "2026-05-P1",
  periodStart: new Date("2026-05-01T07:00:00.000Z"),
  periodEndExclusive: new Date("2026-05-16T07:00:00.000Z"),
  amountCents: 250_000,
};

const BOB = { coachId: "bob", coachName: "Bob Bell", coachEmail: "bob@example.com" };
const CARA = { coachId: "cara", coachName: "Cara Cole", coachEmail: "cara@example.com" };

function renderSept13Shape(): string {
  const report = buildWorkReport(
    [
      // Ana: an unreviewed off-schedule row, a REVIEWED off-schedule row (an
      // admin entry or an Accept stamps reviewedAt — it does not make the row
      // any less left behind), an off-schedule row WITH a note (a cover), and
      // a SCHEDULED row that was also reviewed (the control: a review date on
      // its own prints nothing).
      logRow({ id: "a-unrev", startAt: pfa(9), endAt: pfa(10), unscheduled: true }),
      logRow({
        id: "a-rev",
        startAt: pfa(11),
        endAt: pfa(12),
        unscheduled: true,
        reviewedAt: STAMP,
      }),
      logRow({
        id: "a-both",
        startAt: pfa(13),
        endAt: pfa(14),
        unscheduled: true,
        scheduleNote: "Bob Bell was scheduled.",
      }),
      logRow({ id: "a-clean", startAt: pfa(15), endAt: pfa(16), reviewedAt: STAMP }),
      // Bob: a clean row carrying a timing note, plus a stipend.
      logRow({
        id: "b-note",
        ...BOB,
        startAt: pfa(7),
        endAt: pfa(8),
        scheduleNote: "Scheduled 7:00 AM–7:30 AM",
      }),
      // Cara: one off-schedule row, already reviewed.
      logRow({
        id: "c-rev",
        ...CARA,
        startAt: pfa(17),
        endAt: pfa(18),
        unscheduled: true,
        reviewedAt: STAMP,
      }),
    ],
    [BOB_STIPEND],
  );
  return renderToStaticMarkup(createElement(WorkPreview, report));
}

/**
 * The `<tbody>` of the table that follows a section's eyebrow heading
 * ("Summary" / "Detail"). Throws, naming the anchor, if any piece is missing.
 */
function tbodyAfterHeading(html: string, heading: "Summary" | "Detail"): string {
  const anchor = `>${heading}</p>`;
  const at = html.indexOf(anchor);
  expect(at, `heading anchor not found in rendered output: ${anchor}`).toBeGreaterThan(-1);
  const open = html.indexOf("<tbody>", at);
  expect(open, `no <tbody> after heading: ${heading}`).toBeGreaterThan(-1);
  const close = html.indexOf("</tbody>", open);
  expect(close, `unterminated <tbody> after heading: ${heading}`).toBeGreaterThan(open);
  return html.slice(open, close);
}

/** Exactly one body row containing `needle`, or a loud failure. */
function rowWith(tbody: string, needle: string): string {
  const rows = [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  const hits = rows.filter((r) => r.includes(needle));
  expect(hits.length, `expected exactly one row containing ${JSON.stringify(needle)}`).toBe(1);
  return hits[0];
}

function cells(row: string): string[] {
  return [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
}

/** The Detail row's Schedule cell (the last column). */
function scheduleCell(html: string, needle: string): string {
  const tds = cells(rowWith(tbodyAfterHeading(html, "Detail"), needle));
  expect(tds.length, `Detail row ${needle} has no cells`).toBeGreaterThan(0);
  return tds[tds.length - 1];
}

/** The Summary row's Entries cell (the second column). */
function entriesCell(html: string, coachName: string): string {
  const tds = cells(rowWith(tbodyAfterHeading(html, "Summary"), coachName));
  expect(tds.length, `Summary row ${coachName} has too few cells`).toBeGreaterThan(1);
  return tds[1];
}

function plain(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** The class list of every element whose whole text is "Not on schedule". */
function pillClasses(fragment: string): string[] {
  return [...fragment.matchAll(/<span class="([^"]*)">Not on schedule<\/span>/g)].map(
    (m) => m[1],
  );
}

describe("🔴 0q — the Work tab Detail marks rows that are not on the schedule", () => {
  it("red pill on the unreviewed off-schedule row, and no reviewed line", () => {
    const cell = scheduleCell(renderSept13Shape(), ">09:00<");
    expect(plain(cell)).toBe("Not on schedule");
    const [pill] = pillClasses(cell);
    expect(pill).toContain("text-danger");
    expect(pill).toContain("bg-danger/10");
  });

  it("🔴 a REVIEWED off-schedule row gets the SAME red pill, plus a gray 'reviewed <date>' line under it", () => {
    const cell = scheduleCell(renderSept13Shape(), ">11:00<");
    expect(plain(cell)).toBe("Not on schedule reviewed 2026-05-02");
    const pills = pillClasses(cell);
    expect(pills).toHaveLength(1);
    // Pill text and danger class on the SAME element.
    expect(pills[0]).toContain("text-danger");
    expect(pills[0]).toContain("bg-danger/10");
    expect(pills[0]).not.toContain("bg-surface-2");
    expect(cell).toMatch(
      /<span class="[^"]*text-\[11px\][^"]*text-fg-subtle[^"]*">reviewed 2026-05-02<\/span>/,
    );
  });

  it("pill AND note both present when a row has both, note keeping its full text in a title", () => {
    const cell = scheduleCell(renderSept13Shape(), ">13:00<");
    const text = plain(cell);
    expect(text).toContain("Not on schedule");
    expect(text).toContain("Bob Bell was scheduled.");
    // Pill first, note below it.
    expect(text.indexOf("Not on schedule")).toBeLessThan(
      text.indexOf("Bob Bell was scheduled."),
    );
    expect(cell).toContain('title="Bob Bell was scheduled."');
  });

  it("a scheduled row (even a reviewed one) and a stipend row show no pill and no reviewed line (control: the reviewed off-schedule row does)", () => {
    const html = renderSept13Shape();
    expect(plain(scheduleCell(html, ">11:00<"))).toContain("reviewed 2026-05-02");
    expect(plain(scheduleCell(html, ">15:00<"))).toBe("");
    expect(plain(scheduleCell(html, "Stipend \u2014"))).toBe("");
    // A scheduled row with a timing note keeps only the note.
    expect(plain(scheduleCell(html, ">07:00<"))).toBe("Scheduled 7:00 AM–7:30 AM");
  });

  it("🔴 nothing left behind looks quiet: every 'Not on schedule' pill in the Detail table is red", () => {
    const tbody = tbodyAfterHeading(renderSept13Shape(), "Detail");
    const pills = pillClasses(tbody);
    // a-unrev, a-rev, a-both, c-rev.
    expect(pills).toHaveLength(4);
    for (const cls of pills) {
      expect(cls).toContain("text-danger");
      expect(cls).not.toContain("bg-surface-2");
    }
  });

  it("adds no wording about pay — or 'accepted' — to any Schedule cell (control: the cells carry the mark)", () => {
    const html = renderSept13Shape();
    for (const needle of [">09:00<", ">11:00<", ">13:00<", ">17:00<"]) {
      const text = plain(scheduleCell(html, needle));
      expect(text).toContain("Not on schedule");
      expect(text.toLowerCase()).not.toMatch(/pay|paid|accepted/);
    }
  });
});

describe("🔴 0q — the Work tab Summary counts not-on-schedule rows per coach", () => {
  it("red count for a coach with off-schedule rows", () => {
    const cell = entriesCell(renderSept13Shape(), "Ana Alvarez");
    expect(plain(cell)).toBe("4 3 not on schedule");
    expect(cell).toMatch(/class="[^"]*text-danger[^"]*"[^>]*>3 not on schedule/);
  });

  it("🔴 still red when every one of them has been reviewed", () => {
    const cell = entriesCell(renderSept13Shape(), "Cara Cole");
    expect(plain(cell)).toBe("1 1 not on schedule");
    expect(cell).toMatch(/class="[^"]*text-danger[^"]*"[^>]*>1 not on schedule/);
    expect(cell).not.toContain("text-fg-subtle");
  });

  it("nothing when the coach has none (control: Ana's cell in the same render has it)", () => {
    const html = renderSept13Shape();
    expect(plain(entriesCell(html, "Ana Alvarez"))).toContain("not on schedule");
    // Bob: one log + one stipend, both on/without a schedule question.
    expect(plain(entriesCell(html, "Bob Bell"))).toBe("2");
  });

  it("the summary line says nothing about pay", () => {
    const text = plain(entriesCell(renderSept13Shape(), "Ana Alvarez"));
    expect(text).toContain("not on schedule");
    expect(text.toLowerCase()).not.toMatch(/pay|paid/);
  });
});
