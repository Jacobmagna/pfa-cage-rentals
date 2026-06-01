import { describe, it, expect } from "vitest";
import { createProgramSchema, updateProgramSchema } from "./program";
import { createAthleteSchema } from "./athlete";
import { createHourLogSchema } from "./hour-log";
import { submitAttendanceSchema } from "./attendance";

describe("createProgramSchema", () => {
  it("accepts no cap and no period", () => {
    expect(createProgramSchema.safeParse({ name: "Open Gym" }).success).toBe(
      true,
    );
  });

  it("accepts both cap and period", () => {
    const r = createProgramSchema.safeParse({
      name: "Elite",
      cap: 12,
      capPeriod: "week",
    });
    expect(r.success).toBe(true);
  });

  it("rejects cap without period", () => {
    expect(
      createProgramSchema.safeParse({ name: "Elite", cap: 12 }).success,
    ).toBe(false);
  });

  it("rejects period without cap", () => {
    expect(
      createProgramSchema.safeParse({ name: "Elite", capPeriod: "month" })
        .success,
    ).toBe(false);
  });

  it("rejects a non-positive cap", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Elite",
        cap: 0,
        capPeriod: "week",
      }).success,
    ).toBe(false);
  });

  it("rejects a non-integer cap", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Elite",
        cap: 1.5,
        capPeriod: "week",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(createProgramSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects an unknown cap period", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Elite",
        cap: 5,
        capPeriod: "year",
      }).success,
    ).toBe(false);
  });
});

describe("updateProgramSchema", () => {
  it("allows clearing both cap and period via null", () => {
    expect(
      updateProgramSchema.safeParse({ cap: null, capPeriod: null }).success,
    ).toBe(true);
  });

  it("rejects clearing only one side", () => {
    expect(
      updateProgramSchema.safeParse({ cap: null, capPeriod: "week" }).success,
    ).toBe(false);
  });

  it("allows an empty update object", () => {
    expect(updateProgramSchema.safeParse({}).success).toBe(true);
  });
});

describe("createAthleteSchema", () => {
  it("parses a valid ISO birthday", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      birthday: "2010-12-10",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an omitted birthday", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a null birthday", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      birthday: null,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-ISO birthday", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      birthday: "12/10/2010",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a datetime where a date is expected", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      birthday: "2010-12-10T00:00:00Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an empty first name", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "",
      lastName: "Lovelace",
      birthday: "2010-12-10",
    });
    expect(r.success).toBe(false);
  });
});

describe("createHourLogSchema", () => {
  it("accepts endAt after startAt", () => {
    const r = createHourLogSchema.safeParse({
      programId: "p1",
      startAt: "2025-05-31T10:00:00Z",
      endAt: "2025-05-31T11:00:00Z",
    });
    expect(r.success).toBe(true);
  });

  it("rejects endAt equal to startAt", () => {
    const r = createHourLogSchema.safeParse({
      programId: "p1",
      startAt: "2025-05-31T10:00:00Z",
      endAt: "2025-05-31T10:00:00Z",
    });
    expect(r.success).toBe(false);
  });

  it("rejects endAt before startAt", () => {
    const r = createHourLogSchema.safeParse({
      programId: "p1",
      startAt: "2025-05-31T12:00:00Z",
      endAt: "2025-05-31T11:00:00Z",
    });
    expect(r.success).toBe(false);
  });
});

describe("submitAttendanceSchema", () => {
  it("accepts a valid submission", () => {
    const r = submitAttendanceSchema.safeParse({
      programId: "p1",
      sessionDate: "2025-05-31",
      records: [
        { athleteId: "a1", present: true },
        { athleteId: "a2", present: false },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("rejects an empty records array", () => {
    const r = submitAttendanceSchema.safeParse({
      programId: "p1",
      sessionDate: "2025-05-31",
      records: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects a non-ISO sessionDate", () => {
    const r = submitAttendanceSchema.safeParse({
      programId: "p1",
      sessionDate: "May 31 2025",
      records: [{ athleteId: "a1", present: true }],
    });
    expect(r.success).toBe(false);
  });
});
