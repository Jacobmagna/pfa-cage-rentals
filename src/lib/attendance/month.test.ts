import { describe, expect, it } from "vitest";
import { currentPfaMonth, resolveAttendanceMonth } from "./month";

describe("resolveAttendanceMonth", () => {
  it("parses a valid YYYY-MM and computes string bounds", () => {
    const m = resolveAttendanceMonth("2026-06");
    expect(m.month).toBe("2026-06");
    expect(m.firstDay).toBe("2026-06-01");
    expect(m.nextMonthFirstDay).toBe("2026-07-01");
    expect(m.prevMonth).toBe("2026-05");
    expect(m.nextMonth).toBe("2026-07");
    expect(m.label).toBe("June 2026");
  });

  it("rolls year on December → next month, January → prev month", () => {
    const dec = resolveAttendanceMonth("2026-12");
    expect(dec.nextMonth).toBe("2027-01");
    expect(dec.nextMonthFirstDay).toBe("2027-01-01");
    expect(dec.prevMonth).toBe("2026-11");

    const jan = resolveAttendanceMonth("2026-01");
    expect(jan.prevMonth).toBe("2025-12");
    expect(jan.firstDay).toBe("2026-01-01");
    expect(jan.nextMonthFirstDay).toBe("2026-02-01");
  });

  it("falls back to the current PFA month for missing/invalid input", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const cur = currentPfaMonth(now);
    expect(resolveAttendanceMonth(undefined, now).month).toBe(cur);
    expect(resolveAttendanceMonth("", now).month).toBe(cur);
    expect(resolveAttendanceMonth("2026-13", now).month).toBe(cur);
    expect(resolveAttendanceMonth("2026-00", now).month).toBe(cur);
    expect(resolveAttendanceMonth("not-a-month", now).month).toBe(cur);
    expect(resolveAttendanceMonth("2026-6", now).month).toBe(cur);
  });

  it("currentPfaMonth uses PFA TZ (late-night UTC may be prior PFA day, same month here)", () => {
    // 2026-06-01 03:00 UTC = 2026-05-31 20:00 Pacific → May.
    const lateUtc = new Date("2026-06-01T03:00:00Z");
    expect(currentPfaMonth(lateUtc)).toBe("2026-05");
  });
});
