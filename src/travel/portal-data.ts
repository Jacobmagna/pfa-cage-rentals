// Travel (Block 1 Parent Portal): server-only loader for the guardian
// landing page (/travel/portal). Given a signed-in travel guardian id, it
// resolves that guardian's athletes and each athlete's team(s) into the
// grouped tree the page renders. Read-only.
//
// Shape ported from Northstar's getGuardianPortalData, adapted to the
// travel-native schema:
//   travel_guardian_athletes (by guardianId)
//     → travel_athletes
//       → travel_team_athletes → travel_teams
//         → travel_divisions (division name) / travel_locations (location name)
//
// ONE joined query (LEFT JOINs from the athlete outward, so a teamless
// athlete still appears and a team with no division/location still appears)
// fans out into flat (athlete × team) rows; we fold them back into the
// deduped athlete tree in code. Athletes are ordered by last then first name.

import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  travelAthletes,
  travelDivisions,
  travelGuardianAthletes,
  travelInvoices,
  travelLocations,
  travelProducts,
  travelTeamAthletes,
  travelTeams,
} from "@/db/schema";

export type PortalTeam = {
  id: string;
  name: string;
  divisionName: string | null;
  locationName: string | null;
};

export type PortalAthlete = {
  id: string;
  firstName: string;
  lastName: string;
  gradYear: number | null;
  jerseyNo: string | null;
  positions: string | null;
  teams: PortalTeam[];
};

export type TravelPortalData = {
  athletes: PortalAthlete[];
};

export async function getTravelPortalData(
  guardianId: string,
): Promise<TravelPortalData> {
  // One joined fan-out: this guardian's athletes, each LEFT-JOINed to their
  // team memberships → teams (so a teamless athlete still appears) and each
  // team LEFT-JOINed to its division/location for the display labels. Ordered
  // by athlete last then first name so the grouping below emits them sorted.
  const rows = await db
    .select({
      athleteId: travelAthletes.id,
      athleteFirstName: travelAthletes.firstName,
      athleteLastName: travelAthletes.lastName,
      athleteGradYear: travelAthletes.gradYear,
      athleteJerseyNo: travelAthletes.jerseyNo,
      athletePositions: travelAthletes.positions,
      teamId: travelTeams.id,
      teamName: travelTeams.name,
      divisionName: travelDivisions.name,
      locationName: travelLocations.name,
    })
    .from(travelGuardianAthletes)
    .innerJoin(
      travelAthletes,
      eq(travelAthletes.id, travelGuardianAthletes.athleteId),
    )
    .leftJoin(
      travelTeamAthletes,
      eq(travelTeamAthletes.athleteId, travelAthletes.id),
    )
    .leftJoin(travelTeams, eq(travelTeams.id, travelTeamAthletes.teamId))
    .leftJoin(
      travelDivisions,
      eq(travelDivisions.id, travelTeams.divisionId),
    )
    .leftJoin(
      travelLocations,
      eq(travelLocations.id, travelTeams.locationId),
    )
    .where(eq(travelGuardianAthletes.guardianId, guardianId))
    .orderBy(asc(travelAthletes.lastName), asc(travelAthletes.firstName));

  // Fold the flat (athlete × team) rows into a deduped athlete list, each
  // with its distinct teams. Athletes appear in the query's sorted order; an
  // athlete with only NULL-team rows yields `teams: []`. A team is attached
  // once per athlete (deduped on teamId) so a double-join can't duplicate it.
  const byAthlete = new Map<string, PortalAthlete>();
  const seenTeamIds = new Map<string, Set<string>>();

  for (const row of rows) {
    let athlete = byAthlete.get(row.athleteId);
    if (!athlete) {
      athlete = {
        id: row.athleteId,
        firstName: row.athleteFirstName,
        lastName: row.athleteLastName,
        gradYear: row.athleteGradYear,
        jerseyNo: row.athleteJerseyNo,
        positions: row.athletePositions,
        teams: [],
      };
      byAthlete.set(row.athleteId, athlete);
      seenTeamIds.set(row.athleteId, new Set());
    }

    // NULL teamId = the LEFT JOIN placeholder for a teamless athlete; the
    // athlete row above is enough, so skip attaching a team.
    if (row.teamId == null) continue;

    const seen = seenTeamIds.get(row.athleteId)!;
    if (seen.has(row.teamId)) continue;
    seen.add(row.teamId);
    athlete.teams.push({
      id: row.teamId,
      name: row.teamName ?? "",
      divisionName: row.divisionName,
      locationName: row.locationName,
    });
  }

  return { athletes: [...byAthlete.values()] };
}

// ---------------------------------------------------------------------------
// Block 4c — the guardian billing read. Given a signed-in travel guardian id,
// returns that guardian's OWN invoices (what they owe) for the checkout page.
// Read-only.
//
// SECURITY — IDOR boundary: scoped to travelInvoices.guardianId === guardianId,
// so a guardian can only ever see their own dues. LEFT JOINs the product (name)
// and athlete (name) for display; a null-product/athlete invoice still appears.
// Newest first. `isPayable` is precomputed so the page can decide the Pay button
// without re-deriving the status rule (kept in lockstep with payments.ts's
// FINAL_STATUSES + balance > 0 check).
// ---------------------------------------------------------------------------

// Invoice statuses that take no new online payment (mirrors payments.ts).
const BILLING_FINAL_STATUSES = new Set(["paid", "void", "refunded"]);

export type PortalInvoice = {
  id: string;
  productName: string | null;
  athleteName: string | null;
  totalCents: number;
  balanceCents: number;
  status: string;
  createdAt: Date;
  isPayable: boolean;
};

export async function listTravelInvoicesForGuardian(
  guardianId: string,
): Promise<PortalInvoice[]> {
  const rows = await db
    .select({
      id: travelInvoices.id,
      productName: travelProducts.name,
      athleteFirstName: travelAthletes.firstName,
      athleteLastName: travelAthletes.lastName,
      totalCents: travelInvoices.totalCents,
      balanceCents: travelInvoices.balanceCents,
      status: travelInvoices.status,
      createdAt: travelInvoices.createdAt,
    })
    .from(travelInvoices)
    .leftJoin(travelProducts, eq(travelProducts.id, travelInvoices.productId))
    .leftJoin(travelAthletes, eq(travelAthletes.id, travelInvoices.athleteId))
    .where(eq(travelInvoices.guardianId, guardianId))
    .orderBy(desc(travelInvoices.createdAt));

  return rows.map((row) => {
    const athleteName =
      row.athleteFirstName || row.athleteLastName
        ? `${row.athleteFirstName ?? ""} ${row.athleteLastName ?? ""}`.trim()
        : null;
    return {
      id: row.id,
      productName: row.productName,
      athleteName,
      totalCents: row.totalCents,
      balanceCents: row.balanceCents,
      status: row.status,
      createdAt: row.createdAt,
      isPayable:
        !BILLING_FINAL_STATUSES.has(row.status) && row.balanceCents > 0,
    };
  });
}
