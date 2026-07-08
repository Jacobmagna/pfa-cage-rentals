// Travel-native GUARDIAN (parent) session lifecycle. Facility-admin/OAuth
// sessions are minted by the Auth.js DrizzleAdapter (user_id set); guardian
// sessions are minted HERE (guardian_id set, user_id null) against the SAME
// physical `travel_sessions` table, under the SAME cookie name + options as
// the adapter (exported from src/travel/auth.ts) so a browser holds either
// kind of session under one cookie without ambiguity. The
// `travel_sessions_subject_ck` CHECK enforces exactly-one-of user_id/guardian_id.
//
// server-only: it reads/writes the session cookie + session table.

import "server-only";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { travelGuardians, travelSessions } from "@/db/schema";
import {
  travelSessionCookieName,
  travelSessionCookieOptions,
} from "@/travel/auth";

// 90-day rolling session, mirroring the adapter session maxAge in auth.ts.
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_S = 90 * 24 * 60 * 60;

/**
 * Mint a guardian session: INSERT a `travel_sessions` row (guardian_id set,
 * user_id null, expires now + 90d) and set the travel session cookie to the
 * new token with the SAME name/options the Auth.js adapter uses.
 */
export async function createTravelGuardianSession(
  guardianId: string,
): Promise<void> {
  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(travelSessions).values({
    sessionToken,
    guardianId,
    userId: null,
    expires,
  });

  const cookieStore = await cookies();
  cookieStore.set(travelSessionCookieName, sessionToken, {
    ...travelSessionCookieOptions,
    expires,
    maxAge: SESSION_MAX_AGE_S,
  });
}

/**
 * End the current guardian session: read the cookie token, DELETE the matching
 * GUARDIAN session row (guardian_id NOT NULL — never touches adapter/facility
 * rows), and clear the cookie. Safe to call with no/expired cookie.
 */
export async function destroyTravelGuardianSession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(travelSessionCookieName)?.value;

  if (token) {
    await db
      .delete(travelSessions)
      .where(
        and(
          eq(travelSessions.sessionToken, token),
          isNotNull(travelSessions.guardianId),
        ),
      );
  }

  cookieStore.delete(travelSessionCookieName);
}

/**
 * Resolve the guardian behind the current travel session cookie, or null.
 * Looks up `travel_sessions` by the cookie token WHERE guardian_id IS NOT NULL
 * AND expires > now, joined to `travel_guardians`. Facility-admin sessions
 * (guardian_id null) never match here — they resolve via `auth()` instead.
 */
export async function getTravelGuardianFromCookie(): Promise<{
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: Date | null;
} | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(travelSessionCookieName)?.value;
  if (!token) return null;

  const rows = await db
    .select({
      id: travelGuardians.id,
      email: travelGuardians.email,
      firstName: travelGuardians.firstName,
      lastName: travelGuardians.lastName,
      emailVerified: travelGuardians.emailVerified,
    })
    .from(travelSessions)
    .innerJoin(
      travelGuardians,
      eq(travelSessions.guardianId, travelGuardians.id),
    )
    .where(
      and(
        eq(travelSessions.sessionToken, token),
        isNotNull(travelSessions.guardianId),
        gt(travelSessions.expires, new Date()),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}
