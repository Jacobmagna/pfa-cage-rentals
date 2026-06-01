import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { athletePrograms, athletes, programs } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { AddAthleteForm } from "./_components/add-athlete-form";
import { RosterClient, type AthleteRow } from "./_components/roster-client";

// Roster sub-tab (FEAT-07). Admin-only: athletes are minors' PII and
// never surface on a public route. Server-fetches all athletes, their
// program assignments (one join query, grouped in memory — no N+1), and
// the active-programs list for the assign sidebar, then hands them to
// the client island. The <h1> + sub-nav live in the section layout.
export default async function RosterPage() {
  await requireRole("admin");

  const [athleteRows, assignmentRows, activePrograms] = await Promise.all([
    db
      .select()
      .from(athletes)
      .orderBy(asc(athletes.lastName), asc(athletes.firstName)),
    // All assignments joined to the program name — one query, grouped
    // per athlete below.
    db
      .select({
        athleteId: athletePrograms.athleteId,
        programId: athletePrograms.programId,
        programName: programs.name,
      })
      .from(athletePrograms)
      .innerJoin(programs, eq(athletePrograms.programId, programs.id))
      .orderBy(asc(programs.name)),
    db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(eq(programs.active, true))
      .orderBy(asc(programs.name)),
  ]);

  // Group program badges per athlete in memory.
  const byAthlete = new Map<string, { id: string; name: string }[]>();
  for (const row of assignmentRows) {
    const list = byAthlete.get(row.athleteId) ?? [];
    list.push({ id: row.programId, name: row.programName });
    byAthlete.set(row.athleteId, list);
  }

  const rows: AthleteRow[] = athleteRows.map((a) => ({
    id: a.id,
    firstName: a.firstName,
    lastName: a.lastName,
    birthday: a.birthday,
    programs: byAthlete.get(a.id) ?? [],
  }));

  return (
    <div className="space-y-6">
      <AddAthleteForm />
      <RosterClient athletes={rows} programs={activePrograms} />
    </div>
  );
}
