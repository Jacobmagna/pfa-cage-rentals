import { describe, it, expect } from "vitest";
import { activeTab } from "./tab-nav.logic";

describe("activeTab", () => {
  it("returns cage for the admin section root with no role (back-compat)", () => {
    expect(activeTab("/admin")).toBe("cage");
  });

  it("returns home for the admin section root when role is admin", () => {
    expect(activeTab("/admin", "admin")).toBe("home");
  });

  it("returns home for the admin root with a trailing slash when role is admin", () => {
    expect(activeTab("/admin/", "admin")).toBe("home");
  });

  it("returns cage for /admin/cage-rentals when role is admin", () => {
    expect(activeTab("/admin/cage-rentals", "admin")).toBe("cage");
  });

  it("returns cage for /admin/sessions when role is admin", () => {
    expect(activeTab("/admin/sessions", "admin")).toBe("cage");
  });

  it("returns cage for the coach section root", () => {
    expect(activeTab("/coach")).toBe("cage");
  });

  it("returns cage for the coach section root when role is coach", () => {
    expect(activeTab("/coach", "coach")).toBe("cage");
  });

  it("returns hour-log for /admin/hour-log when role is admin", () => {
    expect(activeTab("/admin/hour-log", "admin")).toBe("hour-log");
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

  it("returns schedule for /coach/schedule when role is coach", () => {
    expect(activeTab("/coach/schedule", "coach")).toBe("schedule");
  });

  it("returns schedule for nested /coach/schedule/2026 when role is coach", () => {
    expect(activeTab("/coach/schedule/2026", "coach")).toBe("schedule");
  });

  it("returns cage for /admin/schedule (admin shell unchanged)", () => {
    expect(activeTab("/admin/schedule", "admin")).toBe("cage");
  });

  it("returns cage for /admin/schedule with no role (back-compat)", () => {
    expect(activeTab("/admin/schedule")).toBe("cage");
  });

  it("returns cage for /coach/schedule with no role (not schedule)", () => {
    expect(activeTab("/coach/schedule")).toBe("cage");
  });

  it("returns records for /admin/records when role is admin", () => {
    expect(activeTab("/admin/records", "admin")).toBe("records");
  });

  it("returns records for /admin/coaches when role is admin", () => {
    expect(activeTab("/admin/coaches", "admin")).toBe("records");
  });

  it("returns records for nested /admin/coaches/123 when role is admin", () => {
    expect(activeTab("/admin/coaches/123", "admin")).toBe("records");
  });

  it("returns records for /admin/reports when role is admin", () => {
    expect(activeTab("/admin/reports", "admin")).toBe("records");
  });

  it("returns records for /admin/payments when role is admin", () => {
    expect(activeTab("/admin/payments", "admin")).toBe("records");
  });

  it("returns records for /admin/audit when role is admin", () => {
    expect(activeTab("/admin/audit", "admin")).toBe("records");
  });

  it("returns records for /admin/import when role is admin", () => {
    expect(activeTab("/admin/import", "admin")).toBe("records");
  });

  it("returns records for /admin/settings when role is admin", () => {
    expect(activeTab("/admin/settings", "admin")).toBe("records");
  });

  it("returns cage for /admin/sessions when role is admin (records guard)", () => {
    expect(activeTab("/admin/sessions", "admin")).toBe("cage");
  });

  it("returns cage for /admin/schedule when role is admin (records guard)", () => {
    expect(activeTab("/admin/schedule", "admin")).toBe("cage");
  });

  it("returns cage for /admin/cage-rentals when role is admin (records guard)", () => {
    expect(activeTab("/admin/cage-rentals", "admin")).toBe("cage");
  });

  it("returns home for /admin when role is admin (records guard)", () => {
    expect(activeTab("/admin", "admin")).toBe("home");
  });

  it("returns cage for /admin/coaches/123 with no role (back-compat, records gated on admin)", () => {
    expect(activeTab("/admin/coaches/123")).toBe("cage");
  });

  it("returns master for /master/schedule with no role", () => {
    expect(activeTab("/master/schedule")).toBe("master");
  });

  it("returns master for /master/schedule when role is admin", () => {
    expect(activeTab("/master/schedule", "admin")).toBe("master");
  });

  it("returns master for /master/schedule when role is coach", () => {
    expect(activeTab("/master/schedule", "coach")).toBe("master");
  });

  it("returns master for /master/work-schedule with no role", () => {
    expect(activeTab("/master/work-schedule")).toBe("master");
  });

  it("returns master for /master/work-schedule when role is admin", () => {
    expect(activeTab("/master/work-schedule", "admin")).toBe("master");
  });

  it("returns master for /master/work-schedule when role is coach", () => {
    expect(activeTab("/master/work-schedule", "coach")).toBe("master");
  });
});
