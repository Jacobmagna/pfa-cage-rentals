import { describe, it, expect } from "vitest";
import { createProgramSchema, updateProgramSchema } from "./program";
import { createAthleteSchema, updateAthleteSchema } from "./athlete";
import { createHourLogSchema } from "./hour-log";
import { submitAttendanceSchema } from "./attendance";
import {
  createProgramScheduleBlockSchema,
  updateProgramScheduleBlockSchema,
} from "./program-schedule";

describe("createProgramSchema", () => {
  it("accepts no cap and no period", () => {
    expect(createProgramSchema.safeParse({ name: "Open Gym" }).success).toBe(
      true,
    );
  });

  it("accepts null cap and null period (uncapped create via form)", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Open Gym",
        cap: null,
        capPeriod: null,
      }).success,
    ).toBe(true);
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

  it("accepts a valid term string", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      term: "Summer 2026",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a null term", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      term: null,
    });
    expect(r.success).toBe(true);
  });

  it("accepts an omitted term", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a term longer than 50 chars", () => {
    const r = createAthleteSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      term: "x".repeat(51),
    });
    expect(r.success).toBe(false);
  });
});

describe("updateAthleteSchema", () => {
  it("accepts a valid term string", () => {
    const r = updateAthleteSchema.safeParse({ term: "Fall 2025" });
    expect(r.success).toBe(true);
  });

  it("accepts a null term (clears it)", () => {
    const r = updateAthleteSchema.safeParse({ term: null });
    expect(r.success).toBe(true);
  });

  it("accepts an omitted term", () => {
    const r = updateAthleteSchema.safeParse({ firstName: "Grace" });
    expect(r.success).toBe(true);
  });

  it("rejects a term longer than 50 chars", () => {
    const r = updateAthleteSchema.safeParse({ term: "x".repeat(51) });
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

describe("createProgramScheduleBlockSchema", () => {
  const base = {
    programId: "prog-1",
    scheduledCoachId: "coach-1",
    startAt: "2026-06-01T14:00:00.000Z",
    endAt: "2026-06-01T15:00:00.000Z",
  };

  it("accepts a valid block (coerces ISO strings to Dates)", () => {
    const r = createProgramScheduleBlockSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.startAt).toBeInstanceOf(Date);
      expect(r.data.endAt).toBeInstanceOf(Date);
    }
  });

  it("rejects endAt <= startAt (zero-length)", () => {
    const r = createProgramScheduleBlockSchema.safeParse({
      ...base,
      endAt: base.startAt,
    });
    expect(r.success).toBe(false);
  });

  it("rejects endAt before startAt", () => {
    const r = createProgramScheduleBlockSchema.safeParse({
      ...base,
      startAt: "2026-06-01T15:00:00.000Z",
      endAt: "2026-06-01T14:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  it("treats note as optional (omitted is fine)", () => {
    expect(createProgramScheduleBlockSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a nullish note", () => {
    expect(
      createProgramScheduleBlockSchema.safeParse({ ...base, note: null })
        .success,
    ).toBe(true);
  });

  it("rejects a note longer than 200 characters", () => {
    const r = createProgramScheduleBlockSchema.safeParse({
      ...base,
      note: "x".repeat(201),
    });
    expect(r.success).toBe(false);
  });

  it("rejects a missing programId", () => {
    const r = createProgramScheduleBlockSchema.safeParse({
      ...base,
      programId: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("updateProgramScheduleBlockSchema", () => {
  it("accepts an empty partial (no fields)", () => {
    expect(updateProgramScheduleBlockSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a single-field partial (note only)", () => {
    expect(
      updateProgramScheduleBlockSchema.safeParse({ note: "moved indoors" })
        .success,
    ).toBe(true);
  });

  it("accepts a start-only partial (end>start refine is guarded)", () => {
    expect(
      updateProgramScheduleBlockSchema.safeParse({
        startAt: "2026-06-01T14:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("rejects when both start + end are present and end <= start", () => {
    const r = updateProgramScheduleBlockSchema.safeParse({
      startAt: "2026-06-01T15:00:00.000Z",
      endAt: "2026-06-01T14:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });
});
