// Zod schema for submitting attendance: one program, one PFA-local
// calendar day, and a present/absent mark per athlete. `sessionDate` is
// a "YYYY-MM-DD" calendar day (z.iso.date() rejects datetime strings),
// matching the attendance_sessions.session_date `date` column.

import { z } from "zod";
import { isoDateString } from "./athlete";

export const attendanceRecordInputSchema = z.object({
  athleteId: z.string().min(1, "athleteId is required"),
  present: z.boolean(),
});

export const submitAttendanceSchema = z.object({
  programId: z.string().min(1, "programId is required"),
  sessionDate: isoDateString,
  records: z
    .array(attendanceRecordInputSchema)
    .min(1, "at least one record is required"),
});

export type AttendanceRecordInput = z.infer<typeof attendanceRecordInputSchema>;
export type SubmitAttendanceInput = z.infer<typeof submitAttendanceSchema>;
