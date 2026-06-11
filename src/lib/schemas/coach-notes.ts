// QA2 #8 — Zod schema for the per-coach admin-notes mutation.
//
// Notes are free-text and optional. An empty input clears the column
// (transform "" → null) so a freshly-emptied textarea reads back as
// "no notes" rather than an empty string. Capped at 2000 chars to keep
// the column sane and the audit diff readable.

import { z } from "zod";

export const COACH_NOTES_MAX = 2000;

const notes = z
  .string()
  .max(COACH_NOTES_MAX, `Notes must be ${COACH_NOTES_MAX} characters or fewer`)
  .transform((v) => {
    const trimmed = v.trim();
    return trimmed === "" ? null : trimmed;
  })
  .nullable();

export const updateCoachNotesSchema = z.object({
  coachId: z.string().min(1, "coachId is required"),
  notes,
});

export type UpdateCoachNotesInput = z.infer<typeof updateCoachNotesSchema>;
