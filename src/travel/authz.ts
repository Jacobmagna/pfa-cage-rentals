// Travel auth guards for server components + server actions. Mirrors the
// facility `src/lib/authz.ts` pattern, but reads the TRAVEL session (via the
// travel NextAuth instance) and redirects to the travel sign-in page.
//
// All guards use `redirect()` from next/navigation on failure. redirect()
// throws internally, so guards never return on the failure path — the calling
// body after the guard runs only when authorization succeeded.

import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { auth } from "@/travel/auth";

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

/**
 * Resolves the current TRAVEL session and redirects to /travel/signin if
 * absent. Any authenticated travel user passes — for the future parent portal.
 * Returned session is typed as definitely-authed.
 */
export async function requireTravelSession(): Promise<TravelAuthedSession> {
  const session = await auth();
  if (!session?.user?.id) redirect("/travel/signin");
  return session as TravelAuthedSession;
}

/**
 * Authorizes the travel operator surface: passes only when the user is a
 * facility admin (role === "admin") OR carries the travel operator flag
 * (travelAdmin === true). Anyone else is bounced back to /travel/signin.
 * Returns the session on success.
 */
export async function requireTravelAccess(): Promise<TravelAuthedSession> {
  const session = await requireTravelSession();
  const user = session.user;
  if (user.role === "admin" || user.travelAdmin === true) {
    return session;
  }
  redirect("/travel/signin");
}
