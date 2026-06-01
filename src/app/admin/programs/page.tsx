import Link from "next/link";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { coachPrograms, programs, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { AddProgramForm } from "./_components/add-program-form";
import { ProgramsClient, type ProgramRow } from "./_components/programs-client";

// /admin/programs (FEAT-08, DEC-23). Admin-only CRUD over training
// programs: create / edit / deactivate (soft-delete, DEC-10), set or
// clear a per-program session cap + period (DEC-03), and assign which
// coaches run each program — the only surface that writes coach_programs
// (DEC-04), so coaches' Hour-Log / Attendance program dropdowns stop
// coming up empty.
//
// Server-fetches all programs, every coach_programs row joined to the
// coach's user record (grouped per program in memory — no N+1), and the
// active-coach list for the assignment multi-select, then hands them to
// the client island. This route has no section layout, so the page owns
// its own <h1>.
export default async function ProgramsPage() {
  await requireRole("admin");

  const [programRows, assignmentRows, coachRows] = await Promise.all([
    db.select().from(programs).orderBy(asc(programs.name)),
    // Every coach assignment joined to the coach's user record — one
    // query, grouped per program below.
    db
      .select({
        programId: coachPrograms.programId,
        coachId: coachPrograms.coachId,
        coachName: users.name,
        coachEmail: users.email,
      })
      .from(coachPrograms)
      .innerJoin(users, eq(coachPrograms.coachId, users.id))
      .orderBy(asc(users.name), asc(users.email)),
    // Active coaches only (role=coach, not soft-deleted) for the picker.
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
  ]);

  // Group coach badges per program in memory.
  const byProgram = new Map<
    string,
    { id: string; name: string }[]
  >();
  for (const row of assignmentRows) {
    const list = byProgram.get(row.programId) ?? [];
    list.push({ id: row.coachId, name: row.coachName ?? row.coachEmail });
    byProgram.set(row.programId, list);
  }

  const rows: ProgramRow[] = programRows.map((p) => ({
    id: p.id,
    name: p.name,
    cap: p.cap,
    capPeriod: p.capPeriod,
    active: p.active,
    coaches: byProgram.get(p.id) ?? [],
  }));

  const coachOptions = coachRows.map((c) => ({
    value: c.id,
    label: c.name ?? c.email,
  }));

  const activeCount = rows.filter((r) => r.active).length;

  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-2xl font-bold tracking-tight">Programs</h1>
        <p className="text-sm text-fg-muted">
          Create programs, set session caps, and assign the coaches who run
          each one. {activeCount} {activeCount === 1 ? "program" : "programs"}{" "}
          active.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
      </div>

      <div className="space-y-6">
        <AddProgramForm />
        <ProgramsClient programs={rows} coachOptions={coachOptions} />
      </div>
    </>
  );
}
