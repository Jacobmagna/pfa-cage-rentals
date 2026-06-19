import { describe, expect, it } from "vitest";
import { formatHHMMTo12h, parseTimeToHHMM } from "./time-input";

describe("parseTimeToHHMM — flexible parse", () => {
  it("parses 12-hour with explicit meridiem", () => {
    expect(parseTimeToHHMM("2:30 PM")).toBe("14:30");
    expect(parseTimeToHHMM("2:30pm")).toBe("14:30");
    expect(parseTimeToHHMM("2:30am")).toBe("02:30");
  });

  it("parses compact and loosely-spaced forms", () => {
    expect(parseTimeToHHMM("230pm")).toBe("14:30");
    expect(parseTimeToHHMM("2 30 pm")).toBe("14:30");
  });

  it("parses 24-hour forms", () => {
    expect(parseTimeToHHMM("14:30")).toBe("14:30");
    expect(parseTimeToHHMM("1430")).toBe("14:30");
  });

  it("parses hour-only forms", () => {
    expect(parseTimeToHHMM("2pm")).toBe("14:00");
    // bare "2" defaults to PM (see "bare-hour PM default" below)
    expect(parseTimeToHHMM("2")).toBe("14:00");
  });
});

describe("parseTimeToHHMM — bare-hour PM default (Jacob QA 2026-06-18)", () => {
  it("bare hours 1–7 default to PM", () => {
    expect(parseTimeToHHMM("1")).toBe("13:00");
    expect(parseTimeToHHMM("3")).toBe("15:00");
    expect(parseTimeToHHMM("7")).toBe("19:00");
    expect(parseTimeToHHMM("330")).toBe("15:30");
    expect(parseTimeToHHMM("3:30")).toBe("15:30");
  });

  it("bare hours 8–11 stay AM (morning camps)", () => {
    expect(parseTimeToHHMM("8")).toBe("08:00");
    expect(parseTimeToHHMM("9")).toBe("09:00");
    expect(parseTimeToHHMM("11")).toBe("11:00");
  });

  it("bare 12 stays noon, bare 0 stays midnight", () => {
    expect(parseTimeToHHMM("12")).toBe("12:00");
    expect(parseTimeToHHMM("0")).toBe("00:00");
  });

  it("explicit am overrides the default", () => {
    expect(parseTimeToHHMM("3am")).toBe("03:00");
    expect(parseTimeToHHMM("7 am")).toBe("07:00");
  });

  it("4-digit 24-hour entries are left literal", () => {
    expect(parseTimeToHHMM("1430")).toBe("14:30");
    expect(parseTimeToHHMM("0700")).toBe("07:00");
  });
});

describe("parseTimeToHHMM — 30-minute snap", () => {
  it("snaps minute 0–14 down to :00", () => {
    expect(parseTimeToHHMM("2:10pm")).toBe("14:00");
    expect(parseTimeToHHMM("14:14")).toBe("14:00");
  });

  it("snaps minute 15–44 to :30", () => {
    expect(parseTimeToHHMM("14:15")).toBe("14:30");
    expect(parseTimeToHHMM("14:44")).toBe("14:30");
  });

  it("snaps minute 45–59 up to the next hour :00", () => {
    expect(parseTimeToHHMM("2:50pm")).toBe("15:00");
    expect(parseTimeToHHMM("14:45")).toBe("15:00");
  });
});

describe("parseTimeToHHMM — clamp", () => {
  it("clamps 23:45+ to 23:30 (never 24:00)", () => {
    expect(parseTimeToHHMM("11:50 pm")).toBe("23:30");
    expect(parseTimeToHHMM("23:55")).toBe("23:30");
  });
});

describe("parseTimeToHHMM — midnight / noon edges", () => {
  it("12:00 am → 00:00", () => {
    expect(parseTimeToHHMM("12:00 am")).toBe("00:00");
  });

  it("12:00 pm → 12:00", () => {
    expect(parseTimeToHHMM("12:00 pm")).toBe("12:00");
  });
});

describe("parseTimeToHHMM — empty / garbage", () => {
  it("returns '' for empty and unparseable input", () => {
    expect(parseTimeToHHMM("")).toBe("");
    expect(parseTimeToHHMM("   ")).toBe("");
    expect(parseTimeToHHMM("abc")).toBe("");
    expect(parseTimeToHHMM("99:99")).toBe("");
  });
});

describe("formatHHMMTo12h", () => {
  it("formats canonical 24h to friendly 12h", () => {
    expect(formatHHMMTo12h("14:30")).toBe("2:30 PM");
    expect(formatHHMMTo12h("00:00")).toBe("12:00 AM");
    expect(formatHHMMTo12h("12:00")).toBe("12:00 PM");
  });

  it("returns '' for empty / malformed", () => {
    expect(formatHHMMTo12h("")).toBe("");
    expect(formatHHMMTo12h("2:30 PM")).toBe("");
    expect(formatHHMMTo12h("99:99")).toBe("");
  });
});

describe("round-trip parse ⇄ format", () => {
  it("14:30 ⇄ 2:30 PM", () => {
    const hhmm = parseTimeToHHMM("2:30 PM");
    expect(hhmm).toBe("14:30");
    expect(formatHHMMTo12h(hhmm)).toBe("2:30 PM");
  });
});
