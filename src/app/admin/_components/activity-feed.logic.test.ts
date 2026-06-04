import { describe, expect, it } from "vitest";
import { describeActivity } from "./activity-feed.logic";

describe("describeActivity", () => {
  it("maps session create/update/delete to cage labels", () => {
    expect(describeActivity("session", "create")).toEqual({
      kind: "cage",
      label: "Logged cage rental",
    });
    expect(describeActivity("session", "update")).toEqual({
      kind: "cage",
      label: "Edited cage rental",
    });
    expect(describeActivity("session", "delete")).toEqual({
      kind: "cage",
      label: "Removed cage rental",
    });
  });

  it("maps hour_log create/update/delete to program labels", () => {
    expect(describeActivity("hour_log", "create")).toEqual({
      kind: "program",
      label: "Logged program hours",
    });
    expect(describeActivity("hour_log", "update")).toEqual({
      kind: "program",
      label: "Edited hours",
    });
    expect(describeActivity("hour_log", "delete")).toEqual({
      kind: "program",
      label: "Removed hours",
    });
  });

  it("maps attendance_session create/update/delete to attendance labels", () => {
    expect(describeActivity("attendance_session", "create")).toEqual({
      kind: "attendance",
      label: "Took attendance",
    });
    expect(describeActivity("attendance_session", "update")).toEqual({
      kind: "attendance",
      label: "Updated attendance",
    });
    expect(describeActivity("attendance_session", "delete")).toEqual({
      kind: "attendance",
      label: "Cleared attendance",
    });
  });

  it("returns null for uninteresting entity types", () => {
    expect(describeActivity("user", "create")).toBeNull();
    expect(describeActivity("program", "update")).toBeNull();
    expect(describeActivity("resource", "delete")).toBeNull();
  });
});
