// Zod schemas for athlete mutations and athlete→program assignment.
// `birthday` is a calendar date ("YYYY-MM-DD"); z.iso.date() rejects
// datetime strings, matching the Postgres `date` column.

import { z } from "zod";

// Calendar date string, "YYYY-MM-DD" (no time, no zone).
export const isoDateString = z.iso.date();

export const createAthleteSchema = z.object({
  firstName: z.string().min(1, "firstName is required").max(100),
  lastName: z.string().min(1, "lastName is required").max(100),
  // Optional: the DB column is nullable so seed/import can omit a
  // birthday. When supplied it must still be a valid "YYYY-MM-DD" date.
  // A form that wants to require it enforces that at the form layer.
  birthday: isoDateString.nullish(),
  // Optional normalized term string ("Season YYYY", e.g. "Summer 2026").
  // Nullish so seed/import can omit it; the add/edit form composes the
  // value from its season + year pickers (DEC-28).
  term: z.string().trim().min(1).max(50).nullish(),
});

export const updateAthleteSchema = z.object({
  firstName: z.string().min(1, "firstName is required").max(100).optional(),
  lastName: z.string().min(1, "lastName is required").max(100).optional(),
  birthday: isoDateString.nullish(),
  term: z.string().trim().min(1).max(50).nullish(),
});

// Per-enrollment session-cap window. Must match the
// enrollment_cap_period pgEnum in src/db/schema.ts: "week" (Sun–Sat),
// "month" (calendar month), "total" (whole program, no reset).
export const enrollmentCapPeriodSchema = z.enum(["week", "month", "total"]);

// Both-or-neither: cap and capPeriod are co-required for an assignment.
// `undefined` and `null` both count as "absent" so the box-unchecked path
// (no cap) and the box-checked path (cap + period) share one rule. Mirrors
// the program-level capCoRequired refine in src/lib/schemas/program.ts.
function assignCapCoRequired(v: {
  cap?: number | null;
  capPeriod?: "week" | "month" | "total" | null;
}): boolean {
  const hasCap = v.cap !== undefined && v.cap !== null;
  const hasPeriod = v.capPeriod !== undefined && v.capPeriod !== null;
  return hasCap === hasPeriod;
}

const assignCapCoRequiredError = {
  message: "cap and capPeriod must be set together or both omitted",
  path: ["cap"],
};

// Assign one or more athletes to one OR MORE programs in one submit.
//   - "add"  — upsert (athleteId, programId) idempotently for each selected
//     program; keeps any existing assignments the athlete already has.
//   - "move" — clear ALL the athlete's program assignments, then insert the
//     selected program(s); net effect is the athlete belongs to exactly the
//     selected set.
// cap/capPeriod set the per-enrollment session cap for the assigned
// athlete(s) (both present = cap; both absent = no cap / clear it). The cap
// (when present) applies to EVERY selected (athlete × program) enrollment.
export const assignAthletesToProgramSchema = z
  .object({
    athleteIds: z.array(z.string().min(1)).min(1, "at least one athlete"),
    programIds: z
      .array(z.string().min(1))
      .min(1, "at least one program"),
    mode: z.enum(["add", "move"]).default("add"),
    // Coerce from the form string; a positive whole number of sessions.
    cap: z.coerce.number().int().positive().nullish(),
    capPeriod: enrollmentCapPeriodSchema.nullish(),
  })
  .refine(assignCapCoRequired, assignCapCoRequiredError);

// Merge one or more duplicate "source" athletes into a single "survivor"
// (#17 roster dedup). The survivor is kept; each source's attendance +
// enrollments are re-pointed onto the survivor and the source row deleted.
// Capped at 20 sources per call (a dedup group is realistically 2–3).
export const mergeAthletesSchema = z.object({
  survivorId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1).max(20),
});

// Persist a "these two athletes are NOT duplicates" decision so the pair
// never re-surfaces in detection. Order-independent — the action canonicalizes.
export const dismissDuplicateSchema = z.object({
  athleteAId: z.string().min(1),
  athleteBId: z.string().min(1),
});

export type CreateAthleteInput = z.infer<typeof createAthleteSchema>;
export type UpdateAthleteInput = z.infer<typeof updateAthleteSchema>;
export type AssignAthletesToProgramInput = z.infer<
  typeof assignAthletesToProgramSchema
>;
export type MergeAthletesInput = z.infer<typeof mergeAthletesSchema>;
export type DismissDuplicateInput = z.infer<typeof dismissDuplicateSchema>;
