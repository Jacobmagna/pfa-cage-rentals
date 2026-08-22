// 🔴 STIPEND SPEC §2.13 — the eligibility field's read semantics.
//
// The whole point of this module is that "absent" must NOT mean "false". A
// program form that has the control always submits an explicit answer; a
// payload without the field is a form that never asked, and writing `false`
// there would silently switch a program's stipend coverage OFF and start
// paying its logs hourly ON TOP of the coach's stipend.
//
// The two-value hidden input is what makes that distinction possible, so the
// three-way return (`true` / `false` / `undefined`) is the property under test,
// not an implementation detail.

import { describe, expect, it } from "vitest";
import {
  readStipendEligible,
  stipendEligibleFormValue,
  STIPEND_ELIGIBLE_FIELD,
} from "./program-stipend-field";

/** A submitted program form carrying whatever fields the caller lists. */
function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

/** What the real form submits for a given checkbox state. */
function submittedBy(checked: boolean): FormData {
  return form({ [STIPEND_ELIGIBLE_FIELD]: stipendEligibleFormValue(checked) });
}

describe("stipendEligibleFormValue", () => {
  it("submits a distinct string for each state — never an empty one", () => {
    expect(stipendEligibleFormValue(true)).toBe("true");
    expect(stipendEligibleFormValue(false)).toBe("false");
    // 🔴 The invariant that matters: an UNTICKED box still submits something.
    // An empty string would be indistinguishable from an absent field once it
    // reached readStipendEligible.
    expect(stipendEligibleFormValue(false)).not.toBe("");
  });
});

describe("readStipendEligible — round trip through the real form value", () => {
  it("reads back a ticked box as true", () => {
    expect(readStipendEligible(submittedBy(true))).toBe(true);
  });

  it("reads back an UNTICKED box as false, not undefined", () => {
    // The paired control for the test below: unticked and absent must not
    // collapse to the same answer, so both are asserted on the same shape.
    expect(readStipendEligible(submittedBy(false))).toBe(false);
  });
});

describe("🔴 readStipendEligible — absent means LEAVE IT ALONE", () => {
  it("returns undefined when the form never carried the field", () => {
    // A rename-only or bulk-edit form posting to updateProgramFormAction.
    expect(readStipendEligible(form({ name: "Manager Work" }))).toBeUndefined();
  });

  it("returns undefined for an empty form", () => {
    expect(readStipendEligible(new FormData())).toBeUndefined();
  });

  it("returns undefined — NOT false — for a value we did not author", () => {
    // Only a hand-built payload produces these. Refusing to write is the safe
    // reading; `false` would be a payroll change nobody requested.
    for (const raw of ["", "on", "1", "0", "TRUE", "yes", "null"]) {
      expect(
        readStipendEligible(form({ [STIPEND_ELIGIBLE_FIELD]: raw })),
      ).toBeUndefined();
    }
  });

  it("🔴 undefined is a THIRD answer, distinct from both booleans", () => {
    // The property the caller depends on: `undefined` must never be coerced
    // by the reader into either boolean, because updateProgramInternal
    // branches on `!== undefined` to decide whether to touch the column.
    const absent = readStipendEligible(new FormData());
    expect(absent).not.toBe(true);
    expect(absent).not.toBe(false);
    expect(absent).toBeUndefined();
  });
});
