// Travel auth guards for server components + server actions. A travel session
// can belong to EITHER a facility admin / travel operator (an Auth.js adapter
// session, user_id set — resolved via the travel NextAuth instance) OR a
// travel-native GUARDIAN / parent (a guardian_id session minted by
// src/travel/session.ts). These guards resolve a unified TravelViewer over both
// subjects and gate each surface to the right kind.
//
// All guards use `redirect()` from next/navigation on failure. redirect()
// throws internally, so guards never return on the failure path — the calling
// body after the guard runs only when authorization succeeded.

import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { auth } from "@/travel/auth";
import { getTravelGuardianFromCookie } from "@/travel/session";

// The travel session's user, viewed with the `travelAdmin` flag the travel
// session callback stamps on. The facility `types/next-auth.d.ts` types
// `session.user` as a closed inline intersection we don't own, so we widen it
// here rather than mutating that shared declaration.
export type TravelSessionUser = NonNullable<Session["user"]> & {
  travelAdmin?: boolean;
};

export type TravelAuthedSession = Session & {
  user: TravelSessionUser;
};

// A travel-native guardian (parent) subject, as resolved from the guardian
// session cookie.
export type TravelGuardian = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: Date | null;
};

// A unified travel viewer: either an Auth.js user session (facility admin /
// travel operator) or a travel-native guardian. Discriminated by `kind`.
export type TravelViewer =
  | { kind: "user"; session: TravelAuthedSession }
  | { kind: "guardian"; guardian: TravelGuardian };

/**
 * Resolve the current travel viewer, or null if unauthenticated. Prefers the
 * Auth.js user session (facility admin / OAuth, user_id) — if present it wins.
 * Otherwise falls back to the guardian session cookie. Does NOT redirect.
 */
export async function getTravelViewer(): Promise<TravelViewer | null> {
  const session = await auth();
  if (session?.user?.id) {
    return { kind: "user", session: session as TravelAuthedSession };
  }

  const guardian = await getTravelGuardianFromCookie();
  if (guardian) {
    return { kind: "guardian", guardian };
  }

  return null;
}

/**
 * Resolves the current TRAVEL viewer (either subject kind) and redirects to
 * /travel/signin if absent. Use when a surface is open to any authed travel
 * viewer regardless of kind.
 */
export async function requireTravelSession(): Promise<TravelViewer> {
  const viewer = await getTravelViewer();
  if (!viewer) redirect("/travel/signin");
  return viewer;
}

/**
 * Authorizes the travel OPERATOR surface: passes only when the viewer is a
 * user session AND that user is a facility admin (role === "admin") OR carries
 * the travel operator flag (travelAdmin === true). Anyone else (including a
 * guardian) is bounced to /travel/signin. Returns the user session unchanged
 * so existing operator pages (e.g. admin/page.tsx reading session.user.email)
 * keep working.
 */
export async function requireTravelAccess(): Promise<TravelAuthedSession> {
  const viewer = await getTravelViewer();
  if (viewer?.kind === "user") {
    const user = viewer.session.user;
    if (user.role === "admin" || user.travelAdmin === true) {
      return viewer.session;
    }
  }
  redirect("/travel/signin");
}

/**
 * Authorizes the travel PARENT portal: passes only when the viewer is a
 * travel-native guardian. A facility admin is NOT a guardian — they use the
 * operator surface, not the parent portal — so a user session is rejected here.
 * Returns the guardian on success; otherwise redirects to /travel/signin.
 */
export async function requireTravelGuardian(): Promise<TravelGuardian> {
  const viewer = await getTravelViewer();
  if (viewer?.kind === "guardian") {
    return viewer.guardian;
  }
  redirect("/travel/signin");
}
