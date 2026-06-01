import { asc, eq, isNotNull } from "drizzle-orm";
import { Archive } from "lucide-react";
import { db } from "@/db";
import { athletePrograms, athletes, programs } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  ArchiveClient,
  type ArchivedAthleteRow,
} from "./_components/archive-client";

// Archive sub-tab (DEC-28). Admin-only. Lists the archived athletes —
// those with a non-null archivedAt (the visibility flag mirroring
// users.deletedAt) — with their term + program badges, and offers a bulk
// Restore. Archiving never deletes athlete_programs, so badges survive.
// The <h1> + sub-nav live in the section layout.
export default async function ArchivePage() {
  await requireRole("admin");

  const [athleteRows, assignmentRows] = await Promise.all([
    db
      .select()
      .from(athletes)
      .where(isNotNull(athletes.archivedAt))
      .orderBy(asc(athletes.lastName), asc(athletes.firstName)),
    db
      .select({
        athleteId: athletePrograms.athleteId,
        programId: athletePrograms.programId,
        programName: programs.name,
      })
      .from(athletePrograms)
      .innerJoin(programs, eq(athletePrograms.programId, programs.id))
      .orderBy(asc(programs.name)),
  ]);

  // Group program badges per athlete in memory (mirrors the roster page).
  const byAthlete = new Map<string, { id: string; name: string }[]>();
  for (const row of assignmentRows) {
    const list = byAthlete.get(row.athleteId) ?? [];
    list.push({ id: row.programId, name: row.programName });
    byAthlete.set(row.athleteId, list);
  }

  const rows: ArchivedAthleteRow[] = athleteRows.map((a) => ({
    id: a.id,
    firstName: a.firstName,
    lastName: a.lastName,
    birthday: a.birthday,
    term: a.term,
    programs: byAthlete.get(a.id) ?? [],
  }));

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-line/60 bg-surface/40 p-12 text-center">
        <Archive
          className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-fg">No archived athletes.</p>
        <p className="mt-1.5 text-sm text-fg-muted">
          Archive athletes from the Roster tab to clear out a prior term.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <ArchiveClient athletes={rows} />
    </div>
  );
}
