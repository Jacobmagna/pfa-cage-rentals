import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { athletePrograms, athletes, programs } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { AddAthleteForm } from "./_components/add-athlete-form";
import { RosterClient, type AthleteRow } from "./_components/roster-client";
import { TermFilter } from "./_components/term-filter";

// Roster sub-tab (FEAT-07 / FEAT-14). Admin-only: athletes are minors'
// PII and never surface on a public route. Server-fetches the NON-archived
// athletes (archive is a visibility flag — DEC-28), their program
// assignments (one join query, grouped in memory — no N+1), the active
// programs list for the assign sidebar, and the distinct terms for the
// filter, then hands them to the client island. An optional ?term= filter
// narrows the list to one term. The <h1> + sub-nav live in the layout.

function firstParam(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

export default async function RosterPage({
  searchParams,
}: {
  searchParams: Promise<{ term?: string | string[] }>;
}) {
  await requireRole("admin");
  const params = await searchParams;

  // Distinct non-null terms among non-archived athletes → filter options.
  const termRows = await db
    .selectDistinct({ term: athletes.term })
    .from(athletes)
    .where(and(isNull(athletes.archivedAt), isNotNull(athletes.term)))
    .orderBy(asc(athletes.term));
  const termOptions = termRows
    .map((r) => r.term)
    .filter((t): t is string => t != null);

  // Validate the requested term against the known set; unknown → "All".
  const requestedTerm = firstParam(params.term);
  const selectedTerm = termOptions.includes(requestedTerm) ? requestedTerm : "";

  const athleteWhere = selectedTerm
    ? and(isNull(athletes.archivedAt), eq(athletes.term, selectedTerm))
    : isNull(athletes.archivedAt);

  const [athleteRows, assignmentRows, activePrograms] = await Promise.all([
    db
      .select()
      .from(athletes)
      .where(athleteWhere)
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
    term: a.term,
    programs: byAthlete.get(a.id) ?? [],
  }));

  return (
    <div className="space-y-6">
      <AddAthleteForm />
      {termOptions.length > 0 ? (
        <TermFilter terms={termOptions} selectedTerm={selectedTerm} />
      ) : null}
      <RosterClient athletes={rows} programs={activePrograms} />
    </div>
  );
}
