import { describe, it, expect } from "vitest";
import { activeTab } from "./tab-nav.logic";

describe("activeTab", () => {
  it("returns cage for the admin section root", () => {
    expect(activeTab("/admin")).toBe("cage");
  });

  it("returns cage for the coach section root", () => {
    expect(activeTab("/coach")).toBe("cage");
  });

  it("returns hour-log for /admin/hour-log", () => {
    expect(activeTab("/admin/hour-log")).toBe("hour-log");
  });

  it("returns hour-log for nested /admin/hour-log/whatever", () => {
    expect(activeTab("/admin/hour-log/whatever")).toBe("hour-log");
  });

  it("returns hour-log for /coach/hour-log", () => {
    expect(activeTab("/coach/hour-log")).toBe("hour-log");
  });

  it("returns attendance for /admin/attendance", () => {
    expect(activeTab("/admin/attendance")).toBe("attendance");
  });

  it("returns attendance for /coach/attendance", () => {
    expect(activeTab("/coach/attendance")).toBe("attendance");
  });

  it("returns attendance for nested /coach/attendance/2026", () => {
    expect(activeTab("/coach/attendance/2026")).toBe("attendance");
  });

  it("returns cage for existing admin cage sub-routes", () => {
    expect(activeTab("/admin/sessions")).toBe("cage");
    expect(activeTab("/admin/coaches/123")).toBe("cage");
  });

  it("returns cage for existing coach cage sub-routes", () => {
    expect(activeTab("/coach/sessions/new")).toBe("cage");
  });

  it("handles trailing slashes", () => {
    expect(activeTab("/admin/")).toBe("cage");
    expect(activeTab("/admin/hour-log/")).toBe("hour-log");
  });
});
