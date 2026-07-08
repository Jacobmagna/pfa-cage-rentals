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

import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  travelAthletes,
  travelDivisions,
  travelGuardianAthletes,
  travelLocations,
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
