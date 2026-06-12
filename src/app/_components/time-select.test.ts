import { describe, expect, it } from "vitest";
import { buildOptions } from "./time-select";

const values = (variant: "start" | "end", step: 15 | 30) =>
  buildOptions(variant, step).map((o) => o.value);

describe("buildOptions — 30-min (default granularity)", () => {
  it("start options are on the half-hour: include 08:00 and 08:30 but not 08:15", () => {
    const v = values("start", 30);
    expect(v).toContain("08:00");
    expect(v).toContain("08:30");
    expect(v).not.toContain("08:15");
  });

  it("start bounds are 08:00..21:30", () => {
    const v = values("start", 30);
    expect(v[0]).toBe("08:00");
    expect(v[v.length - 1]).toBe("21:30");
  });

  it("end bounds are 08:30..22:00", () => {
    const v = values("end", 30);
    expect(v[0]).toBe("08:30");
    expect(v[v.length - 1]).toBe("22:00");
    expect(v).not.toContain("08:15");
  });
});

describe("buildOptions — 15-min granularity", () => {
  it("start options include the quarter-hours 08:15 and 08:45", () => {
    const v = values("start", 15);
    expect(v).toContain("08:15");
    expect(v).toContain("08:45");
  });

  it("start bounds are 08:00..21:45", () => {
    const v = values("start", 15);
    expect(v[0]).toBe("08:00");
    expect(v[v.length - 1]).toBe("21:45");
  });

  it("end bounds are 08:15..22:00", () => {
    const v = values("end", 15);
    expect(v[0]).toBe("08:15");
    expect(v[v.length - 1]).toBe("22:00");
  });
});
