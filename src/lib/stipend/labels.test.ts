// stipend SPEC §10.4/§10.5 — the shared stipend WORDS, and the two properties
// of the work-pay caveat that a workbook cannot enforce for itself.
//
// 🔴 BOTH ASSERTIONS BELOW EXIST BECAUSE THE ADVERSARIAL PASS FOUND THE BUG
// THEY DESCRIBE, not because they were predicted.
//
//   1. The caveat was shipped as ONE joined string into `addNoteRows`, whose
//      own comment says a note row lives in column A and clips past ~90
//      characters. The joined sentence is 134 — it would have been cut off
//      mid-sentence on the deliverable Mark emails around, on the surface
//      whose comment says that is worse than not having a caveat at all.
//   2. Writing the joined string NEXT TO its own second sentence printed
//      "Payments made outside the app are not deducted here." twice.
//
// Neither was reachable by any existing assertion: the workbook tests check
// figures, and three Excel defects in this repo's history were found only by
// opening the file. These pin the two properties in code instead.

import { describe, expect, it } from "vitest";
import {
  COVERED_BY_STIPEND_LABEL,
  STIPEND_FLAT_RATE_LABEL,
  STIPEND_LINE_LABEL,
  WORK_PAY_CAVEAT,
  WORK_PAY_CAVEAT_LEAD,
  WORK_PAY_CAVEAT_PAYMENTS,
  WORK_SCOPE_NOTE_TEXT,
} from "./labels";

/** The width a note row can overflow into before Excel clips it. */
const EXCEL_NOTE_ROW_LIMIT = 90;

describe("🔴 the work-pay caveat fits an Excel note row", () => {
  it("each half is short enough to survive column A", () => {
    expect(WORK_PAY_CAVEAT_LEAD.length).toBeLessThanOrEqual(EXCEL_NOTE_ROW_LIMIT);
    expect(WORK_PAY_CAVEAT_PAYMENTS.length).toBeLessThanOrEqual(
      EXCEL_NOTE_ROW_LIMIT,
    );
  });

  it("🔴 the JOINED sentence would NOT fit — which is why it is split", () => {
    // The positive control. If this ever stops being true the split has become
    // unnecessary, and someone should be told rather than left guessing why
    // two constants exist.
    expect(WORK_PAY_CAVEAT.length).toBeGreaterThan(EXCEL_NOTE_ROW_LIMIT);
  });

  it("the joined form is exactly the two halves, one space apart", () => {
    // Otherwise the screen and the workbook quote subtly different sentences,
    // which is the drift this constant was created to end.
    expect(WORK_PAY_CAVEAT).toBe(
      `${WORK_PAY_CAVEAT_LEAD} ${WORK_PAY_CAVEAT_PAYMENTS}`,
    );
  });

  it("🔴 the halves do not repeat each other", () => {
    // The duplicate-line defect: the lead must not already contain the
    // payments sentence, or writing both as rows prints it twice.
    expect(WORK_PAY_CAVEAT_LEAD).not.toContain(WORK_PAY_CAVEAT_PAYMENTS);
  });
});

describe("the caveat says what is now true", () => {
  it("🔴 no longer claims the figure is only logged work", () => {
    // A stipend is not logged work. The old wording became false the moment a
    // stipend line could sit beside it.
    expect(WORK_PAY_CAVEAT).not.toContain("the logged work is worth");
    expect(WORK_PAY_CAVEAT_LEAD).toContain("stipends");
  });

  it("still says outside payments are not deducted", () => {
    // Overstating what a coach is owed IN WRITING is the most expensive
    // mistake available in this feature.
    expect(WORK_PAY_CAVEAT).toMatch(/not deducted/i);
  });

  it("the scope note states the no-pro-rating rule", () => {
    expect(WORK_SCOPE_NOTE_TEXT).toMatch(/never pro-rated/i);
    expect(WORK_SCOPE_NOTE_TEXT).toMatch(/posted work only/i);
  });
});

describe("the rate labels are distinct and never a rendered zero", () => {
  it("no label is a dollar figure", () => {
    // "$0.00/hr" reads as a decision to pay nothing per hour — a different and
    // wrong claim. "No rate" already exists for exactly this reason.
    for (const label of [
      COVERED_BY_STIPEND_LABEL,
      STIPEND_FLAT_RATE_LABEL,
      STIPEND_LINE_LABEL,
    ]) {
      expect(label).not.toMatch(/\$|\d/);
    }
  });

  it("a covered LOG and a stipend ROW do not read the same", () => {
    // They mean different things: one is real hours deliberately not charged,
    // the other is the amount that pays for them.
    expect(COVERED_BY_STIPEND_LABEL).not.toBe(STIPEND_FLAT_RATE_LABEL);
  });
});
