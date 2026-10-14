// The WORDS every pay surface uses for a log with no matching schedule block
// (`0q` Release 1). Pure module, every branch.
//
// 🔴 The branch that matters most: a REJECTED row also carries `reviewedAt`
// (rejecting stamps it), so a rule keyed on `reviewedAt` alone would print
// "accepted" beside work Mark turned down. The tests below pin "accepted" to
// status === "posted" AND reviewedAt set, with the rejected-and-stamped row as
// the control on the same call.

import { describe, expect, it } from "vitest";
import {
  NOT_ON_SCHEDULE_LABEL,
  notOnScheduleState,
  notOnScheduleText,
  postedRowScheduleState,
  scheduleCellText,
} from "./schedule-labels";

const STAMP = new Date("2039-09-13T20:00:00.000Z");

describe("NOT_ON_SCHEDULE_LABEL", () => {
  it("is the exact wording, a fact about the schedule", () => {
    expect(NOT_ON_SCHEDULE_LABEL).toBe("Not on schedule");
  });
});

describe("notOnScheduleState", () => {
  it("a scheduled row is null, whatever its status or review", () => {
    expect(
      notOnScheduleState({ unscheduled: false, status: "posted", reviewedAt: null }),
    ).toBeNull();
    expect(
      notOnScheduleState({ unscheduled: false, status: "posted", reviewedAt: STAMP }),
    ).toBeNull();
    expect(
      notOnScheduleState({ unscheduled: false, status: "rejected", reviewedAt: STAMP }),
    ).toBeNull();
    // Control on the same call: flip ONLY the flag and it is marked (rule 15).
    expect(
      notOnScheduleState({ unscheduled: true, status: "posted", reviewedAt: null }),
    ).not.toBeNull();
  });

  it("posted + not reviewed → unreviewed", () => {
    expect(
      notOnScheduleState({ unscheduled: true, status: "posted", reviewedAt: null }),
    ).toBe("unreviewed");
  });

  it("posted + reviewed → accepted", () => {
    expect(
      notOnScheduleState({ unscheduled: true, status: "posted", reviewedAt: STAMP }),
    ).toBe("accepted");
  });

  it("🔴 rejected WITH reviewedAt set never reads accepted (control: posted+stamped does)", () => {
    const rejected = notOnScheduleState({
      unscheduled: true,
      status: "rejected",
      reviewedAt: STAMP,
    });
    const accepted = notOnScheduleState({
      unscheduled: true,
      status: "posted",
      reviewedAt: STAMP,
    });
    expect(rejected).toBe("rejected");
    expect(rejected).not.toBe("accepted");
    expect(accepted).toBe("accepted");
  });

  it("rejected without a stamp is still rejected", () => {
    expect(
      notOnScheduleState({ unscheduled: true, status: "rejected", reviewedAt: null }),
    ).toBe("rejected");
  });

  it("held (awaiting approval) is never accepted — it reads as unreviewed", () => {
    expect(
      notOnScheduleState({ unscheduled: true, status: "held", reviewedAt: null }),
    ).toBe("unreviewed");
    expect(
      notOnScheduleState({ unscheduled: true, status: "held", reviewedAt: STAMP }),
    ).toBe("unreviewed");
  });
});

describe("postedRowScheduleState (the pay report's rows are posted-only)", () => {
  it("scheduled → null; unreviewed / accepted otherwise", () => {
    expect(postedRowScheduleState({ unscheduled: false, reviewed: false })).toBeNull();
    expect(postedRowScheduleState({ unscheduled: false, reviewed: true })).toBeNull();
    expect(postedRowScheduleState({ unscheduled: true, reviewed: false })).toBe(
      "unreviewed",
    );
    expect(postedRowScheduleState({ unscheduled: true, reviewed: true })).toBe(
      "accepted",
    );
  });
});

describe("notOnScheduleText", () => {
  it("unreviewed / accepted / rejected, with a middle dot (U+00B7)", () => {
    expect(notOnScheduleText("unreviewed")).toBe("Not on schedule");
    expect(notOnScheduleText("accepted")).toBe("Not on schedule · accepted");
    expect(notOnScheduleText("rejected")).toBe("Not on schedule · rejected");
  });
});

describe("scheduleCellText (the spreadsheet Schedule cell)", () => {
  it("label only, when there is no note", () => {
    expect(scheduleCellText("unreviewed", null)).toBe("Not on schedule");
    expect(scheduleCellText("accepted", null)).toBe(
      "Not on schedule · accepted",
    );
    expect(scheduleCellText("rejected", null)).toBe(
      "Not on schedule · rejected",
    );
  });

  it("label, then '; <note>' when a note also exists", () => {
    expect(scheduleCellText("unreviewed", "Alice Coach was scheduled.")).toBe(
      "Not on schedule; Alice Coach was scheduled.",
    );
    expect(scheduleCellText("accepted", "Alice Coach was scheduled.")).toBe(
      "Not on schedule · accepted; Alice Coach was scheduled.",
    );
  });

  it("just the note when scheduled; empty when neither", () => {
    expect(scheduleCellText(null, "Scheduled 5:00 PM–8:00 PM")).toBe(
      "Scheduled 5:00 PM–8:00 PM",
    );
    expect(scheduleCellText(null, null)).toBe("");
  });

  it("never says anything about pay (control: it does say the schedule fact)", () => {
    for (const state of ["unreviewed", "accepted", "rejected"] as const) {
      const text = scheduleCellText(state, "x");
      expect(text).toContain("Not on schedule");
      expect(text.toLowerCase()).not.toMatch(/pay|paid/);
    }
  });
});
