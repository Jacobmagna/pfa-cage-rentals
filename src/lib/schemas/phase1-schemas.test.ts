import { describe, it, expect } from "vitest";
import { createProgramSchema, updateProgramSchema } from "./program";
import {
  deleteProgramRateOverrideSchema,
  upsertProgramRateOverrideSchema,
} from "./rate-override";
import { createAthleteSchema, updateAthleteSchema } from "./athlete";
import { createHourLogSchema } from "./hour-log";
import { submitAttendanceSchema } from "./attendance";
import {
  createProgramScheduleBlockSchema,
  updateProgramScheduleBlockSchema,
} from "./program-schedule";

describe("createProgramSchema", () => {
  it("accepts a name-only program", () => {
    expect(createProgramSchema.safeParse({ name: "Open Gym" }).success).toBe(
      true,
    );
  });

  it("rejects an empty name", () => {
    expect(createProgramSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("accepts a valid defaultRatePer30MinCents", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Elite",
        defaultRatePer30MinCents: 2200,
      }).success,
    ).toBe(true);
  });

  it("accepts a null defaultRatePer30MinCents (no rate set)", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Elite",
        defaultRatePer30MinCents: null,
      }).success,
    ).toBe(true);
  });

  it("rejects a defaultRatePer30MinCents over the $1,000 cap", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Elite",
        defaultRatePer30MinCents: 100_001,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-integer defaultRatePer30MinCents", () => {
    expect(
      createProgramSchema.safeParse({
        name: "Elite",
        defaultRatePer30MinCents: 22.5,
      }).success,
    ).toBe(false);
  });
});

describe("updateProgramSchema", () => {
  it("allows an empty update object", () => {
    expect(updateProgramSchema.safeParse({}).success).toBe(true);
  });

  it("allows clearing the pay rate via null", () => {
    expect(
      updateProgramSchema.safeParse({ defaultRatePer30MinCents: null })
        .success,
    ).toBe(true);
  });

  it("rejects a pay rate over the $1,000 cap on update", () => {
    expect(
      updateProgramSchema.safeParse({ defaultRatePer30MinCents: 100_001 })
        .success,
    ).toBe(false);
  });
});

describe("upsertProgramRateOverrideSchema", () => {
  const base = { coachId: "c1", programId: "p1" };

  it("accepts a valid override", () => {
    expect(
      upsertProgramRateOverrideSchema.safeParse({
        ...base,
        ratePer30MinCents: 1800,
      }).success,
    ).toBe(true);
  });

  it("rejects a zero rate (must be > $0)", () => {
    expect(
      upsertProgramRateOverrideSchema.safeParse({
        ...base,
        ratePer30MinCents: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects a rate over the $1,000 cap", () => {
    expect(
      upsertProgramRateOverrideSchema.safeParse({
        ...base,
        ratePer30MinCents: 100_001,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing programId", () => {
    expect(
      upsertProgramRateOverrideSchema.safeParse({
        coachId: "c1",
        programId: "",
        ratePer30MinCents: 1800,
      }).success,
    ).toBe(false);
  });
});

describe("deleteProgramRateOverrideSchema", () => {
  it("accepts a valid coach + program pair", () => {
    expect(
      deleteProgramRateOverrideSchema.safeParse({
        coachId: "c1",
        programId: "p1",
      }).success,
    ).toBe(true);
  });

  it("rejects a missing coachId", () => {
    expect(
      deleteProgramRateOverrideSchema.safeParse({
        coachId: "",
        programId: "p1",
      }).success,
    ).toBe(false);
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
