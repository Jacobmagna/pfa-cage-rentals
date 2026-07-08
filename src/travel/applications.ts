// Travel (Block 2): server-only data helpers for the PUBLIC "Request to Join /
// Tryout" application flow (/travel/apply). No auth — a family fills out the
// form, which lands a `travel_applications` row in status `pending`; an
// operator reviews + accepts later (a separate task).
//
//   • listPublicTeams — the teams a family can apply to, each with its
//     (nullable) cohort / division name / location name for the labeled
//     <select>. No isPublic/active column exists yet, so every team is listed,
//     ordered by name.
//   • createApplication — inserts one pending application after server-side
//     validation (required names + a basic email shape). parentEmail is
//     normalized (lowercased + trimmed) before insert.

import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  travelApplications,
  travelDivisions,
  travelLocations,
  travelTeams,
} from "@/db/schema";

export type PublicTeam = {
  id: string;
  name: string;
  cohort: string | null;
  divisionName: string | null;
  locationName: string | null;
};

export async function listPublicTeams(): Promise<PublicTeam[]> {
  // LEFT JOIN division + location so a team with no division/location still
  // appears. Ordered by team name for a stable, human-scannable <select>.
  return db
    .select({
      id: travelTeams.id,
      name: travelTeams.name,
      cohort: travelTeams.cohort,
      divisionName: travelDivisions.name,
      locationName: travelLocations.name,
    })
    .from(travelTeams)
    .leftJoin(travelDivisions, eq(travelDivisions.id, travelTeams.divisionId))
    .leftJoin(travelLocations, eq(travelLocations.id, travelTeams.locationId))
    .orderBy(asc(travelTeams.name));
}

// Error codes returned to the caller (the server action maps these to
// ?error=<code> banners). `missing` = a required field is blank; `email` =
// parent email is present but malformed.
export type CreateApplicationError = "missing" | "email";

export type CreateApplicationInput = {
  teamId: string | null;
  athleteFirstName: string;
  athleteLastName: string;
  athleteGradYear: number | null;
  athletePositions: string | null;
  parentFirstName: string;
  parentLastName: string;
  parentEmail: string;
  parentPhone: string | null;
  message: string | null;
};

// Loose email shape — one @, a dot in the domain, no whitespace. Intentionally
// permissive: real validity is proven later by the operator emailing them back.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Inserts a pending application. Throws `{ code }` (a CreateApplicationError)
// on validation failure so the action can degrade to ?error=<code>; the DB
// `status` column defaults to "pending" so it is not set here.
export async function createApplication(
  input: CreateApplicationInput,
): Promise<void> {
  const athleteFirstName = input.athleteFirstName.trim();
  const athleteLastName = input.athleteLastName.trim();
  const parentFirstName = input.parentFirstName.trim();
  const parentLastName = input.parentLastName.trim();
  const parentEmail = input.parentEmail.trim().toLowerCase();

  if (
    !athleteFirstName ||
    !athleteLastName ||
    !parentFirstName ||
    !parentLastName ||
    !parentEmail
  ) {
    throw { code: "missing" satisfies CreateApplicationError };
  }
  if (!EMAIL_RE.test(parentEmail)) {
    throw { code: "email" satisfies CreateApplicationError };
  }

  await db.insert(travelApplications).values({
    teamId: input.teamId,
    athleteFirstName,
    athleteLastName,
    athleteGradYear: input.athleteGradYear,
    athletePositions: input.athletePositions,
    parentFirstName,
    parentLastName,
    parentEmail,
    parentPhone: input.parentPhone,
    message: input.message,
  });
}
