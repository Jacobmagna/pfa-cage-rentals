// GET /admin/attendance/download?programId=&month=YYYY-MM
// Builds the attendance Excel workbook for one program + month and
// returns it as a download (QA2 #14).
//
// Same program + month contract as the by-program page (shared via
// lib/attendance/month.ts) and the same month-bounded set-based reads,
// so what the admin sees in the on-screen grid matches the workbook they
// download — no surprises. Session dates are plain "YYYY-MM-DD" strings,
// so the month bound is a string range [firstDay, nextMonthFirstDay).

import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  athletePrograms,
  athletes,
  attendanceRecords,
  attendanceSessions,
  programs,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { resolveAttendanceMonth } from "@/lib/attendance/month";
import {
  buildAttendanceGrid,
  type GridAthlete,
} from "@/lib/server/attendance-grid";
import { buildAttendanceWorkbook } from "@/lib/reports/attendance-excel";

export async function GET(request: Request) {
  await requireRole("admin");

  const url = new URL(request.url);
  const requestedProgramId = url.searchParams.get("programId") ?? "";
  const { month, firstDay, nextMonthFirstDay, label } = resolveAttendanceMonth(
    url.searchParams.get("month") ?? undefined,
  );

  // Resolve the program — only active programs are downloadable (mirrors
  // the page's picker allow-list). Unknown/inactive → 404.
  const program = (
    await db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(and(eq(programs.id, requestedProgramId), eq(programs.active, true)))
      .limit(1)
  )[0];

  if (!program) {
    return new Response("Program not found", { status: 404 });
  }

  // Current roster athletes for the program.
  const rosterAthletes = await db
    .select({
      id: athletes.id,
      firstName: athletes.firstName,
      lastName: athletes.lastName,
    })
    .from(athletePrograms)
    .innerJoin(athletes, eq(athletePrograms.athleteId, athletes.id))
    .where(eq(athletePrograms.programId, program.id));

  // The program's attendance sessions WITHIN the selected month only.
  const sessionRows = await db
    .select({
      id: attendanceSessions.id,
      sessionDate: attendanceSessions.sessionDate,
    })
    .from(attendanceSessions)
    .where(
      and(
        eq(attendanceSessions.programId, program.id),
        gte(attendanceSessions.sessionDate, firstDay),
        lt(attendanceSessions.sessionDate, nextMonthFirstDay),
      ),
    )
    .orderBy(asc(attendanceSessions.sessionDate));

  const sessionIds = sessionRows.map((s) => s.id);

  let recordAthletes: GridAthlete[] = [];
  let records: { sessionId: string; athleteId: string; present: boolean }[] =
    [];
  if (sessionIds.length > 0) {
    records = await db
      .select({
        sessionId: attendanceRecords.sessionId,
        athleteId: attendanceRecords.athleteId,
        present: attendanceRecords.present,
      })
      .from(attendanceRecords)
      .where(inArray(attendanceRecords.sessionId, sessionIds));

    recordAthletes = await db
      .selectDistinct({
        id: athletes.id,
        firstName: athletes.firstName,
        lastName: athletes.lastName,
      })
      .from(attendanceRecords)
      .innerJoin(athletes, eq(attendanceRecords.athleteId, athletes.id))
      .where(inArray(attendanceRecords.sessionId, sessionIds));
  }

  const grid = buildAttendanceGrid({
    athletes: [...rosterAthletes, ...recordAthletes],
    sessions: sessionRows,
    records,
  });

  const buffer = await buildAttendanceWorkbook(grid, {
    programName: program.name,
    monthLabel: label,
  });

  const slug = slugify(program.name);
  const filename = `pfa-attendance-${slug}-${month}.xlsx`;

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Tell browsers not to cache the workbook — re-pulling the same
      // month after editing attendance would otherwise see a stale file.
      "Cache-Control": "no-store",
    },
  });
}

// Lowercase, ASCII-word filename slug for the program name so the
// download filename is safe across OSes. Empty → "program".
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "program";
}
