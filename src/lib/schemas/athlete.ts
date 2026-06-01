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
});

export const updateAthleteSchema = z.object({
  firstName: z.string().min(1, "firstName is required").max(100).optional(),
  lastName: z.string().min(1, "lastName is required").max(100).optional(),
  birthday: isoDateString.nullish(),
});

// Assign one or more athletes to a single program.
export const assignAthletesToProgramSchema = z.object({
  athleteIds: z.array(z.string().min(1)).min(1, "at least one athlete"),
  programId: z.string().min(1, "programId is required"),
});

export type CreateAthleteInput = z.infer<typeof createAthleteSchema>;
export type UpdateAthleteInput = z.infer<typeof updateAthleteSchema>;
export type AssignAthletesToProgramInput = z.infer<
  typeof assignAthletesToProgramSchema
>;
