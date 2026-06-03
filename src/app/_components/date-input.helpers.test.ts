import { describe, expect, it } from "vitest";
import { isoToMasked, maskDigits, maskedToIso } from "./date-input";

describe("maskDigits", () => {
  it("inserts slashes as digits are typed", () => {
    expect(maskDigits("06022026")).toBe("06/02/2026");
  });

  it("masks partial input (month + day, no year yet)", () => {
    expect(maskDigits("0602")).toBe("06/02");
  });

  it("masks a single-segment partial (month only)", () => {
    expect(maskDigits("06")).toBe("06");
  });

  it("strips non-digits the user pastes/types", () => {
    expect(maskDigits("06/02/2026")).toBe("06/02/2026");
    expect(maskDigits("ab06cd02ef2026")).toBe("06/02/2026");
  });

  it("caps at 8 digits (MMDDYYYY)", () => {
    expect(maskDigits("0602202699")).toBe("06/02/2026");
  });

  it("returns empty for empty input", () => {
    expect(maskDigits("")).toBe("");
  });
});

describe("isoToMasked", () => {
  it("converts ISO to MM/DD/YYYY", () => {
    expect(isoToMasked("2026-06-02")).toBe("06/02/2026");
  });

  it("returns empty for empty / malformed ISO", () => {
    expect(isoToMasked("")).toBe("");
    expect(isoToMasked("2026/06/02")).toBe("");
    expect(isoToMasked("not-a-date")).toBe("");
  });
});

describe("maskedToIso", () => {
  it("round-trips a valid date back to ISO", () => {
    expect(maskedToIso("06/02/2026")).toBe("2026-06-02");
  });

  it("returns empty for an impossible month/day", () => {
    expect(maskedToIso("13/40/2026")).toBe("");
    expect(maskedToIso("13/01/2026")).toBe("");
    expect(maskedToIso("06/31/2026")).toBe("");
  });

  it("rejects Feb 29 on a non-leap year but allows it on a leap year", () => {
    expect(maskedToIso("02/29/2025")).toBe("");
    expect(maskedToIso("02/29/2024")).toBe("2024-02-29");
  });

  it("returns empty for partial / empty input", () => {
    expect(maskedToIso("06/02")).toBe("");
    expect(maskedToIso("")).toBe("");
  });
});

describe("ISO ⇄ masked round-trip", () => {
  it("round-trips 2026-06-02 ⇄ 06/02/2026", () => {
    const iso = "2026-06-02";
    const masked = isoToMasked(iso);
    expect(masked).toBe("06/02/2026");
    expect(maskedToIso(masked)).toBe(iso);
  });
});
