import Link from "next/link";
import { asc } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { programs } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { AddProgramForm } from "./_components/add-program-form";
import { ProgramsClient, type ProgramRow } from "./_components/programs-client";

// /admin/hour-log/programs (FEAT-08, DEC-23; QA3-1 moved under Hour
// Log). Admin-only CRUD over training programs: create / edit /
// deactivate (soft-delete, DEC-10). The program-level session cap was
// removed — the cap is now a PER-ATHLETE enrollment cap set on the
// Roster assign flow (FEAT-11). Per-program coach assignment was removed
// in DEC-29 — coaches can now log hours / take attendance for ANY active
// program, so there's no coach_programs surface here anymore.
//
// Server-fetches all programs, then hands them to the client island.
// The Hour Log section layout wraps this with the sub-nav; the page
// still owns its own Back link + <h1> (mirrors the schedule sub-tab).
export default async function ProgramsPage() {
  await requireRole("admin");

  const programRows = await db
    .select()
    .from(programs)
    .orderBy(asc(programs.name));

  const rows: ProgramRow[] = programRows.map((p) => ({
    id: p.id,
    name: p.name,
    active: p.active,
    defaultRatePer30MinCents: p.defaultRatePer30MinCents,
  }));

  const activeCount = rows.filter((r) => r.active).length;

  return (
    <>
      <Link
        href="/admin/hour-log"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Work Log
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Work</h1>
        <p className="text-sm text-fg-muted">
          Create and manage work types. {activeCount} active.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
      </div>

      <div className="space-y-6">
        <AddProgramForm />
        <ProgramsClient programs={rows} />
      </div>
    </>
  );
}
