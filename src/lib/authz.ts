// Auth guards for server components and server actions. Every
// route-level component and every "use server" function calls one of
// these as its first line so the rest of the body can assume an
// authenticated, role-appropriate user.
//
// All guards use `redirect()` from next/navigation on failure.
// redirect() throws internally (Next.js catches it), so guards
// never return on the failure path — the calling function's body
// after the guard runs only when authorization succeeded.
//
// Why not return a Result-style discriminated union: every caller
// would just `if (!result.ok) redirect(...)` immediately and the
// indirection helps nobody. Throwing-via-redirect matches Next.js
// idiom and keeps server actions terse.

import { redirect } from "next/navigation";
import type { Session } from "next-auth";
import { auth } from "@/auth";

export type AuthedSession = Session & {
  user: NonNullable<Session["user"]>;
};

/**
 * Resolves the current session and redirects to `/` (sign-in) if
 * absent. Returned session is typed as definitely-authed so callers
 * can use `session.user.id` without a non-null assertion.
 */
export async function requireSession(): Promise<AuthedSession> {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  return session as AuthedSession;
}

/**
 * Resolves the current session and redirects away when the role
 * doesn't match. Coach hitting an admin route lands on /coach;
 * admin hitting a coach-only route lands on /admin (rare but
 * possible — we don't auto-grant admins coach access since the
 * two dashboards are different views and admins have their own).
 */
export async function requireRole(
  role: "coach" | "admin",
): Promise<AuthedSession> {
  const session = await requireSession();
  if (session.user.role !== role) {
    redirect(role === "admin" ? "/coach" : "/admin");
  }
  return session;
}

/**
 * Authorizes access to a row that belongs to one coach. Admins
 * always pass. Coaches pass only when they own the row (coachId
 * matches their user id). Anything else redirects to /coach —
 * appropriate for the URL-guessing case (coach A trying to load
 * /coach/sessions/<coach-B-session-id>).
 *
 * Structural type so this works for billing sessions, blocked
 * times, or anything else with a coachId field, without depending
 * on those tables existing yet (they land in Stage C).
 */
export function requireSessionOwnership(
  row: { coachId: string },
  user: AuthedSession["user"],
): void {
  if (user.role === "admin") return;
  if (row.coachId === user.id) return;
  redirect("/coach");
}
