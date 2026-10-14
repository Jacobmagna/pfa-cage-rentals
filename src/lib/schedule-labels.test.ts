// The WORDS every pay surface uses for a log with no matching schedule block
// (`0q` Release 1). Pure module, every branch.
//
// 🔴 Every left-behind row reads "Not on schedule" — reviewed or not
// (Jacob, 2026-10-14). `reviewedAt` is stamped by admin hour entry, approve-
// held and queue Accept on rows that were ON a block at the time, so it never
// means "accepted as off-schedule"; a reviewed row only gains its review DATE.
// Nothing left behind may read quieter than an unreviewed one.

import { describe, expect, it } from "vitest";
import {
  NOT_ON_SCHEDULE_LABEL,
  reviewedOnText,
  scheduleCellText,
} from "./schedule-labels";

type CellRow = Parameters<typeof scheduleCellText>[0];
function cell(over: Partial<CellRow>): string {
  return scheduleCellText({
    status: "posted",
    unscheduled: false,
    reviewedOn: null,
    scheduleNote: null,
    ...over,
  });
}

describe("NOT_ON_SCHEDULE_LABEL", () => {
  it("is the exact wording, a fact about the schedule", () => {
    expect(NOT_ON_SCHEDULE_LABEL).toBe("Not on schedule");
  });
});

describe("reviewedOnText", () => {
  it("is 'reviewed <date>' with the date exactly as given", () => {
    expect(reviewedOnText("2026-10-03")).toBe("reviewed 2026-10-03");
  });
});

describe("scheduleCellText — POSTED rows (both workbooks)", () => {
  it("unscheduled, not reviewed → 'Not on schedule'", () => {
    expect(cell({ unscheduled: true })).toBe("Not on schedule");
  });

  it("🔴 unscheduled AND reviewed → still 'Not on schedule', with the review date", () => {
    expect(cell({ unscheduled: true, reviewedOn: "2026-10-03" })).toBe(
      "Not on schedule (reviewed 2026-10-03)",
    );
  });

  it("label, then '; <note>' when a note also exists", () => {
    expect(
      cell({ unscheduled: true, scheduleNote: "Alice Coach was scheduled." }),
    ).toBe("Not on schedule; Alice Coach was scheduled.");
    expect(
      cell({
        unscheduled: true,
        reviewedOn: "2026-10-03",
        scheduleNote: "Alice Coach was scheduled.",
      }),
    ).toBe("Not on schedule (reviewed 2026-10-03); Alice Coach was scheduled.");
  });

  it("a SCHEDULED row: just the note, or empty — a review date alone prints nothing (control: unscheduled does)", () => {
    expect(cell({ scheduleNote: "Scheduled 5:00 PM–8:00 PM" })).toBe(
      "Scheduled 5:00 PM–8:00 PM",
    );
    expect(cell({})).toBe("");
    expect(cell({ reviewedOn: "2026-10-03" })).toBe("");
    expect(cell({ unscheduled: true, reviewedOn: "2026-10-03" })).toContain(
      "reviewed 2026-10-03",
    );
  });

  it("a held row (never on these sheets today) reads like an unreviewed posted one", () => {
    expect(cell({ status: "held", unscheduled: true })).toBe("Not on schedule");
  });
});

describe("scheduleCellText — REJECTED rows (hour-log workbook only)", () => {
  it("🔴 EVERY rejected row starts with 'Rejected', on the schedule or not", () => {
    expect(cell({ status: "rejected" })).toBe("Rejected");
    expect(cell({ status: "rejected", unscheduled: true })).toBe(
      "Rejected; Not on schedule",
    );
  });

  it("then '; <note>' when a note exists", () => {
    expect(
      cell({ status: "rejected", scheduleNote: "Scheduled 1:00 PM–2:00 PM" }),
    ).toBe("Rejected; Scheduled 1:00 PM–2:00 PM");
    expect(
      cell({
        status: "rejected",
        unscheduled: true,
        scheduleNote: "Alice Coach was scheduled.",
      }),
    ).toBe("Rejected; Not on schedule; Alice Coach was scheduled.");
  });

  it("carries no review date (rejecting stamps reviewedAt; the word 'Rejected' already says it)", () => {
    expect(
      cell({ status: "rejected", unscheduled: true, reviewedOn: "2026-10-03" }),
    ).toBe("Rejected; Not on schedule");
  });
});

describe("the words never say anything about pay, and never 'accepted'", () => {
  it("across every branch (control: each one says something)", () => {
    const rows: Partial<CellRow>[] = [
      { unscheduled: true },
      { unscheduled: true, reviewedOn: "2026-10-03", scheduleNote: "x" },
      { status: "rejected" },
      { status: "rejected", unscheduled: true, scheduleNote: "x" },
    ];
    for (const r of rows) {
      const text = cell(r);
      expect(typeof text).toBe("string");
      expect(text).not.toBe("");
      expect(text.toLowerCase()).not.toMatch(/pay|paid|accepted/);
    }
  });
});
