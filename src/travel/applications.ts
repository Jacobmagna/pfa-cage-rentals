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

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import {
  travelApplications,
  travelAthletes,
  travelDivisions,
  travelGuardianAthletes,
  travelGuardians,
  travelLocations,
  travelTeamAthletes,
  travelTeams,
} from "@/db/schema";
import { issueClaimToken } from "@/travel/auth-flow";

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

// ---------------------------------------------------------------------------
// OPERATOR review surface (/travel/admin/applications). server-only helpers an
// authed operator uses to review the pending queue and accept/decline. These
// are gated by requireTravelAccess() at the page/action layer — no auth here.
// ---------------------------------------------------------------------------

export type ApplicationStatus = "pending" | "accepted" | "declined";

// One application row for the operator queue: the application's own fields plus
// the (nullable) name of the team it was submitted to (LEFT JOIN — an
// application whose team was later removed still lists, with teamName null).
export type OperatorApplication = {
  id: string;
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
  status: string;
  reviewNote: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  teamName: string | null;
};

/** Lowercase + trim an email for consistent guardian lookups. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * List applications for the operator queue, newest first. Optionally filtered
 * to a single status (the tab the operator is on); omit for all. LEFT JOINs the
 * team so its name can be shown, without dropping team-less applications.
 */
export async function listApplicationsForOperator(
  status?: ApplicationStatus,
): Promise<OperatorApplication[]> {
  const base = db
    .select({
      id: travelApplications.id,
      teamId: travelApplications.teamId,
      athleteFirstName: travelApplications.athleteFirstName,
      athleteLastName: travelApplications.athleteLastName,
      athleteGradYear: travelApplications.athleteGradYear,
      athletePositions: travelApplications.athletePositions,
      parentFirstName: travelApplications.parentFirstName,
      parentLastName: travelApplications.parentLastName,
      parentEmail: travelApplications.parentEmail,
      parentPhone: travelApplications.parentPhone,
      message: travelApplications.message,
      status: travelApplications.status,
      reviewNote: travelApplications.reviewNote,
      reviewedAt: travelApplications.reviewedAt,
      createdAt: travelApplications.createdAt,
      teamName: travelTeams.name,
    })
    .from(travelApplications)
    .leftJoin(travelTeams, eq(travelTeams.id, travelApplications.teamId))
    .orderBy(desc(travelApplications.createdAt));

  return status
    ? base.where(eq(travelApplications.status, status))
    : base;
}

/**
 * Decline a PENDING application: set status='declined', record the (optional)
 * note + reviewedAt. A no-op if the application isn't currently pending (already
 * decided) — the WHERE guards on status so a double-submit can't clobber an
 * accept.
 */
export async function declineApplication(
  applicationId: string,
  note: string | null,
): Promise<void> {
  await db
    .update(travelApplications)
    .set({ status: "declined", reviewNote: note, reviewedAt: new Date() })
    .where(
      and(
        eq(travelApplications.id, applicationId),
        eq(travelApplications.status, "pending"),
      ),
    );
}

export type AcceptResult =
  | { ok: true; onboardingSent: boolean }
  | { ok: false; reason: string };

/**
 * Accept a PENDING application — the core operator action. Idempotent-guarded:
 * only a `pending` application is materialized (never double-creates records).
 *
 * The db (`drizzle-orm/neon-http`) driver does NOT support interactive
 * `db.transaction(async tx => …)` — it throws at runtime. So this does the
 * concurrency gate as a single row-atomic guarded UPDATE (pending→accepted;
 * exactly one racing Accept wins), THEN materializes the guardian/athlete/link/
 * roster rows as one atomic `db.batch([...])`. Explicit ids (`randomUUID()`,
 * matching the schema's `$defaultFn(() => crypto.randomUUID())` id column) are
 * generated up front so later batch rows can reference earlier ones without
 * relying on `.returning()` (which batch can't feed forward).
 *
 * AFTER the commit it sends an onboarding claim link — but ONLY when the
 * guardian is brand-new / unclaimed (no passwordHash). A returning parent who
 * already has a claimed account (adding another kid) is NOT emailed a claim
 * link (they already log in). The email is best-effort: a send failure is
 * logged to Sentry but does NOT fail the already-committed accept.
 */
export async function acceptApplication(
  applicationId: string,
  origin: string,
): Promise<AcceptResult> {
  const [application] = await db
    .select()
    .from(travelApplications)
    .where(eq(travelApplications.id, applicationId))
    .limit(1);

  if (!application) return { ok: false, reason: "not_found" };
  if (application.status !== "pending") {
    return { ok: false, reason: "already_decided" };
  }

  const email = normalizeEmail(application.parentEmail);

  // Race-safe status flip FIRST — the concurrency gate. This single guarded
  // UPDATE is atomic at the row level: only a `pending` row flips, so if two
  // Accepts race exactly one matches (returns a row) and the other gets 0 rows.
  // We do this before creating anything, so losing the race creates nothing.
  const flipped = await db
    .update(travelApplications)
    .set({ status: "accepted", reviewedAt: new Date() })
    .where(
      and(
        eq(travelApplications.id, applicationId),
        eq(travelApplications.status, "pending"),
      ),
    )
    .returning({ id: travelApplications.id });
  if (flipped.length === 0) return { ok: false, reason: "already_decided" };

  // Find the guardian by normalized email (single read).
  const [existing] = await db
    .select({
      id: travelGuardians.id,
      passwordHash: travelGuardians.passwordHash,
    })
    .from(travelGuardians)
    .where(eq(travelGuardians.email, email))
    .limit(1);

  // Decide ids + onboarding. `needsOnboarding` = a claim link should be sent:
  // true for a brand-new guardian, or an existing guardian that never set a
  // password (unclaimed). An existing CLAIMED guardian (has passwordHash)
  // already logs in → false, and is NOT re-inserted.
  let guardianId: string;
  let needsOnboarding: boolean;
  if (existing) {
    guardianId = existing.id;
    needsOnboarding = existing.passwordHash == null;
  } else {
    guardianId = randomUUID();
    needsOnboarding = true;
  }
  const athleteId = randomUUID();

  // Materialize the records as ONE atomic db.batch (the neon-http-safe stand-in
  // for an interactive txn). Explicit ids are passed so later rows reference
  // earlier ones without `.returning()`. The athlete insert is always present,
  // so it anchors the non-empty tuple; the (optional) roster is pushed after,
  // and a NEW-guardian insert is prepended so it commits before its FK refs.
  const ops: BatchItem<"pg">[] = [
    db.insert(travelAthletes).values({
      id: athleteId,
      firstName: application.athleteFirstName,
      lastName: application.athleteLastName,
      gradYear: application.athleteGradYear,
      positions: application.athletePositions,
    }),
    db.insert(travelGuardianAthletes).values({
      guardianId,
      athleteId,
      relationship: null,
      isPrimary: true,
    }),
  ];
  // roster the athlete on the applied-to team, if any. onConflictDoNothing
  // guards the composite PK (a re-add is harmless).
  if (application.teamId) {
    ops.push(
      db
        .insert(travelTeamAthletes)
        .values({ teamId: application.teamId, athleteId, status: "active" })
        .onConflictDoNothing(),
    );
  }
  // A brand-new guardian is inserted (with the explicit id) FIRST so its row
  // exists before the link/roster FKs reference it.
  if (!existing) {
    ops.unshift(
      db.insert(travelGuardians).values({
        id: guardianId,
        firstName: application.parentFirstName,
        lastName: application.parentLastName,
        email,
        phone: application.parentPhone,
        passwordHash: null,
        emailVerified: null,
        isAccountOwner: true,
      }),
    );
  }
  await db.batch(ops as [(typeof ops)[number], ...(typeof ops)[number][]]);

  // Onboarding email — AFTER the commit, best-effort. A returning claimed parent
  // gets no claim link.
  if (!needsOnboarding) return { ok: true, onboardingSent: false };

  try {
    await issueClaimToken(email, origin);
    return { ok: true, onboardingSent: true };
  } catch (err) {
    // The accept already committed — a mail hiccup must not fail it. Log + report
    // no email was sent so the operator can follow up.
    Sentry.captureException(err, {
      tags: { area: "travel-application-accept-onboarding" },
      extra: { applicationId, email },
    });
    return { ok: true, onboardingSent: false };
  }
}
