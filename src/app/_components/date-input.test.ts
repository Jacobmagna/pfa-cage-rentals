// Unit tests for the PURE helpers behind the typable masked DateInput
// (QA10 W1.7). These cover the digit-only mask, the ISO <-> masked
// conversions (including leap-year and out-of-range rejection), the
// digit-indexed caret mapping that keeps the caret at the edit point on
// delete, and the current-year fill that lets a user type only MM/DD.
//
// Every helper is a pure string reshape — none construct a Date — so a
// date can never day-shift across a timezone boundary. We assert that
// explicitly (round-trip ISO is byte-identical).

import { describe, expect, it } from "vitest";
import {
  caretToDigitIndex,
  digitIndexToCaret,
  fillCurrentYear,
  isoToMasked,
  maskDigits,
  maskedToIso,
} from "./date-input";

describe("maskDigits", () => {
  it("strips non-digits and inserts structural slashes as the user types", () => {
    expect(maskDigits("")).toBe("");
    expect(maskDigits("0")).toBe("0");
    expect(maskDigits("06")).toBe("06");
    expect(maskDigits("066")).toBe("06/6");
    expect(maskDigits("0602")).toBe("06/02");
    expect(maskDigits("060220")).toBe("06/02/20");
    expect(maskDigits("06022026")).toBe("06/02/2026");
  });

  it("ignores existing slashes / junk and caps at 8 digits (MMDDYYYY)", () => {
    expect(maskDigits("06/02/2026")).toBe("06/02/2026");
    expect(maskDigits("06022026999")).toBe("06/02/2026");
    expect(maskDigits("ab06cd02ef2026")).toBe("06/02/2026");
  });
});

describe("isoToMasked", () => {
  it("converts a valid ISO to MM/DD/YYYY", () => {
    expect(isoToMasked("2026-06-02")).toBe("06/02/2026");
    expect(isoToMasked("2024-02-29")).toBe("02/29/2024");
  });

  it("returns '' for empty / malformed input", () => {
    expect(isoToMasked("")).toBe("");
    expect(isoToMasked("2026-6-2")).toBe("");
    expect(isoToMasked("06/02/2026")).toBe("");
    // @ts-expect-error guarding the runtime null path
    expect(isoToMasked(null)).toBe("");
  });
});

describe("maskedToIso", () => {
  it("converts a complete valid masked date to ISO with no day-shift", () => {
    expect(maskedToIso("06/02/2026")).toBe("2026-06-02");
    expect(maskedToIso("01/01/2026")).toBe("2026-01-01");
    expect(maskedToIso("12/31/2025")).toBe("2025-12-31");
  });

  it("returns '' for partial / incomplete input", () => {
    expect(maskedToIso("")).toBe("");
    expect(maskedToIso("06")).toBe("");
    expect(maskedToIso("06/02")).toBe("");
    expect(maskedToIso("06/02/202")).toBe("");
  });

  it("accepts Feb 29 in a leap year and rejects it in a common year", () => {
    expect(maskedToIso("02/29/2024")).toBe("2024-02-29"); // leap
    expect(maskedToIso("02/29/2000")).toBe("2000-02-29"); // /400 leap
    expect(maskedToIso("02/29/2023")).toBe(""); // common year
    expect(maskedToIso("02/29/1900")).toBe(""); // /100 not /400 → common
  });

  it("rejects out-of-range month and day", () => {
    expect(maskedToIso("13/01/2026")).toBe(""); // month 13
    expect(maskedToIso("00/10/2026")).toBe(""); // month 0
    expect(maskedToIso("01/32/2026")).toBe(""); // day 32
    expect(maskedToIso("04/31/2026")).toBe(""); // April has 30
    expect(maskedToIso("06/00/2026")).toBe(""); // day 0
    expect(maskedToIso("06/02/0000")).toBe(""); // year 0
  });

  it("round-trips ISO -> masked -> ISO byte-identically (no TZ shift)", () => {
    for (const iso of ["2026-06-02", "2024-02-29", "2025-12-31", "2026-01-01"]) {
      expect(maskedToIso(isoToMasked(iso))).toBe(iso);
    }
  });
});

describe("caretToDigitIndex", () => {
  it("counts digits at or before the caret, ignoring slashes", () => {
    const s = "06/02/2026";
    expect(caretToDigitIndex(s, 0)).toBe(0); // before everything
    expect(caretToDigitIndex(s, 1)).toBe(1); // after "0"
    expect(caretToDigitIndex(s, 2)).toBe(2); // after "06", before slash
    expect(caretToDigitIndex(s, 3)).toBe(2); // after the slash → still 2 digits
    expect(caretToDigitIndex(s, 4)).toBe(3); // after "0" of "02"
    expect(caretToDigitIndex(s, 5)).toBe(4); // after "02"
    expect(caretToDigitIndex(s, 10)).toBe(8); // end → all 8 digits
  });

  it("clamps out-of-range caret offsets", () => {
    const s = "06/02";
    expect(caretToDigitIndex(s, -5)).toBe(0);
    expect(caretToDigitIndex(s, 999)).toBe(4);
  });
});

describe("digitIndexToCaret", () => {
  it("places the caret after N digits, stepping past a trailing slash", () => {
    const s = "06/02/2026";
    expect(digitIndexToCaret(s, 0)).toBe(0);
    // after 2 digits ("06") the next char is "/" → land after the slash
    expect(digitIndexToCaret(s, 2)).toBe(3);
    // after 1 digit, next char is a digit → land right after it
    expect(digitIndexToCaret(s, 1)).toBe(1);
    // after 4 digits ("0602") the next char is "/" → land after the slash
    expect(digitIndexToCaret(s, 4)).toBe(6);
    expect(digitIndexToCaret(s, 8)).toBe(10); // end
  });

  it("lands the caret right after a slash (boundary case)", () => {
    // "06/" — asking for the caret after 2 digits should sit past the slash
    expect(digitIndexToCaret("06/", 2)).toBe(3);
  });

  it("clamps beyond the available digits", () => {
    expect(digitIndexToCaret("06/02", 99)).toBe("06/02".length);
    expect(digitIndexToCaret("06/02", -1)).toBe(0);
  });

  it("is the inverse of caretToDigitIndex at digit boundaries", () => {
    const s = "06/02/2026";
    for (let d = 0; d <= 8; d++) {
      expect(caretToDigitIndex(s, digitIndexToCaret(s, d))).toBe(d);
    }
  });
});

describe("fillCurrentYear", () => {
  it("fills the current year when only MM/DD is present", () => {
    expect(fillCurrentYear("06/02", 2026)).toBe("06/02/2026");
    expect(fillCurrentYear("12/31", 2025)).toBe("12/31/2025");
  });

  it("uses the supplied currentYear param (pure, no Date)", () => {
    expect(fillCurrentYear("01/15", 1999)).toBe("01/15/1999");
  });

  it("leaves a full date unchanged", () => {
    expect(fillCurrentYear("06/02/2024", 2026)).toBe("06/02/2024");
  });

  it("leaves sub-MM/DD partials unchanged (no premature fill)", () => {
    expect(fillCurrentYear("", 2026)).toBe("");
    expect(fillCurrentYear("0", 2026)).toBe("0");
    expect(fillCurrentYear("06", 2026)).toBe("06");
    expect(fillCurrentYear("06/0", 2026)).toBe("06/0");
  });

  it("a current-year-filled MM/DD resolves to a valid ISO with no day-shift", () => {
    const filled = fillCurrentYear("06/02", 2026);
    expect(maskedToIso(filled)).toBe("2026-06-02");
  });
});
