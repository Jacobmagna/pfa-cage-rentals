// Block 5b — the OPERATOR MASTER PLAYER LIST read layer. Impure aggregation over
// tables that already exist (travel_athletes / travel_team_athletes /
// travel_teams / travel_guardian_athletes / travel_guardians / travel_invoices).
// OPERATOR-SCOPE: every travel athlete, NO guardian filtering (unlike the
// guardian-scoped portal-data.ts). The route guards with requireTravelAccess.
//
// READ-ONLY: no writes, no Stripe. This is a roster-oversight spine — one row per
// athlete with their teams, families, and dues rollup.
//
// DRIVER: neon-http (drizzle) — NO db.transaction (read-only anyway).
//
// QUERY SHAPE: to avoid an N+1 fan-out across athletes, we load the capped
// athlete set once (ordered last,first) then batch each child list with a SINGLE
// grouped read keyed by athleteId (teams, guardians, invoices), merging in JS.
// The per-athlete dues math + the search predicate live in the pure
// roster-report.logic.ts so they stay unit-testable.
//
// MONEY: integer cents everywhere; the route formats to USD for display only.

import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  travelAthletes,
  travelGuardianAthletes,
  travelGuardians,
  travelInvoices,
  travelTeamAthletes,
  travelTeams,
} from "@/db/schema";
import {
  foldDues,
  formatPlayerName,
  matchesPlayerSearch,
} from "@/travel/roster-report.logic";

// Defensive cap on the athlete set (this is a single-org roster; any realistic
// travel program is far under this). A runaway table is capped rather than
// loaded unboundedly. Noted in the Final Report as an assumption.
const ATHLETE_READ_CAP = 2000;

export type TravelMasterPlayerTeam = {
  teamId: string;
  teamName: string;
  cohort: string | null;
};

export type TravelMasterPlayerGuardian = {
  guardianId: string;
  guardianName: string;
  email: string;
};

export type TravelMasterPlayerRow = {
  athleteId: string;
  athleteName: string;
  gradYear: number | null;
  ageGroup: string | null;
  positions: string | null;
  teams: TravelMasterPlayerTeam[];
  guardians: TravelMasterPlayerGuardian[];
  billedCents: number;
  collectedCents: number;
  outstandingCents: number;
  invoiceStatuses: string[];
};

export type GetMasterPlayerListOpts = { search?: string };

/**
 * The operator-wide master player list: one row per travel athlete (ALL
 * athletes, capped at ATHLETE_READ_CAP), each with roster memberships, linked
 * guardians (primary first), and a dues rollup from their invoices. Sorted by
 * name (last, first) asc via the athlete query's ORDER BY.
 *
 * `search` (optional, case-insensitive) filters by athlete name OR guardian name
 * OR guardian email OR team name — applied in JS after the child lists are
 * assembled so a match on any joined field keeps the row. Absent → all rows.
 */
export async function getTravelMasterPlayerList(
  opts?: GetMasterPlayerListOpts,
): Promise<TravelMasterPlayerRow[]> {
  // 1) The capped athlete set, already sorted last,first (the row order).
  const athletes = await db
    .select({
      id: travelAthletes.id,
      firstName: travelAthletes.firstName,
      lastName: travelAthletes.lastName,
      gradYear: travelAthletes.gradYear,
      ageGroup: travelAthletes.ageGroup,
      positions: travelAthletes.positions,
    })
    .from(travelAthletes)
    .orderBy(asc(travelAthletes.lastName), asc(travelAthletes.firstName))
    .limit(ATHLETE_READ_CAP);

  if (athletes.length === 0) return [];

  const athleteIds = athletes.map((a) => a.id);

  // 2) Batch each child list with ONE grouped read keyed by athleteId (no N+1).
  const [teamRows, guardianRows, invoiceRows] = await Promise.all([
    db
      .select({
        athleteId: travelTeamAthletes.athleteId,
        teamId: travelTeams.id,
        teamName: travelTeams.name,
        cohort: travelTeams.cohort,
      })
      .from(travelTeamAthletes)
      .innerJoin(travelTeams, eq(travelTeams.id, travelTeamAthletes.teamId))
      .where(inArray(travelTeamAthletes.athleteId, athleteIds))
      .orderBy(asc(travelTeams.name)),
    db
      .select({
        athleteId: travelGuardianAthletes.athleteId,
        guardianId: travelGuardians.id,
        firstName: travelGuardians.firstName,
        lastName: travelGuardians.lastName,
        email: travelGuardians.email,
        isPrimary: travelGuardianAthletes.isPrimary,
      })
      .from(travelGuardianAthletes)
      .innerJoin(
        travelGuardians,
        eq(travelGuardians.id, travelGuardianAthletes.guardianId),
      )
      .where(inArray(travelGuardianAthletes.athleteId, athleteIds))
      // Primary guardians first, then a stable name order.
      .orderBy(
        desc(travelGuardianAthletes.isPrimary),
        asc(travelGuardians.lastName),
        asc(travelGuardians.firstName),
      ),
    db
      .select({
        athleteId: travelInvoices.athleteId,
        totalCents: travelInvoices.totalCents,
        balanceCents: travelInvoices.balanceCents,
        status: travelInvoices.status,
      })
      .from(travelInvoices)
      .where(inArray(travelInvoices.athleteId, athleteIds)),
  ]);

  // 3) Group each child list by athleteId. Teams are deduped per athlete (a
  // roster row can't legitimately duplicate, but the guard is cheap).
  const teamsByAthlete = new Map<string, TravelMasterPlayerTeam[]>();
  const seenTeam = new Map<string, Set<string>>();
  for (const t of teamRows) {
    let list = teamsByAthlete.get(t.athleteId);
    if (!list) {
      list = [];
      teamsByAthlete.set(t.athleteId, list);
      seenTeam.set(t.athleteId, new Set());
    }
    const seen = seenTeam.get(t.athleteId)!;
    if (seen.has(t.teamId)) continue;
    seen.add(t.teamId);
    list.push({ teamId: t.teamId, teamName: t.teamName, cohort: t.cohort });
  }

  const guardiansByAthlete = new Map<string, TravelMasterPlayerGuardian[]>();
  for (const g of guardianRows) {
    let list = guardiansByAthlete.get(g.athleteId);
    if (!list) {
      list = [];
      guardiansByAthlete.set(g.athleteId, list);
    }
    list.push({
      guardianId: g.guardianId,
      guardianName: formatPlayerName(g.firstName, g.lastName),
      email: g.email,
    });
  }

  const invoicesByAthlete = new Map<
    string,
    { totalCents: number; balanceCents: number; status: string }[]
  >();
  for (const inv of invoiceRows) {
    // athleteId is nullable on the invoice (set-null FK); such rows are not in
    // athleteIds so inArray excludes them, but guard the null for the type.
    if (inv.athleteId == null) continue;
    let list = invoicesByAthlete.get(inv.athleteId);
    if (!list) {
      list = [];
      invoicesByAthlete.set(inv.athleteId, list);
    }
    list.push({
      totalCents: inv.totalCents,
      balanceCents: inv.balanceCents,
      status: inv.status,
    });
  }

  // 4) Assemble one row per athlete (already sorted by the athlete query).
  const rows: TravelMasterPlayerRow[] = athletes.map((a) => {
    const dues = foldDues(invoicesByAthlete.get(a.id) ?? []);
    return {
      athleteId: a.id,
      athleteName: formatPlayerName(a.firstName, a.lastName),
      gradYear: a.gradYear,
      ageGroup: a.ageGroup,
      positions: a.positions,
      teams: teamsByAthlete.get(a.id) ?? [],
      guardians: guardiansByAthlete.get(a.id) ?? [],
      billedCents: dues.billedCents,
      collectedCents: dues.collectedCents,
      outstandingCents: dues.outstandingCents,
      invoiceStatuses: dues.invoiceStatuses,
    };
  });

  // 5) Optional search: filter in JS so a match on any joined field (athlete,
  // team, guardian name/email) keeps the row. Order is preserved.
  const q = opts?.search?.trim();
  if (q) return rows.filter((r) => matchesPlayerSearch(r, q));
  return rows;
}
