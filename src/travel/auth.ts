import { cache } from "react";
import * as Sentry from "@sentry/nextjs";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, travelSessions, verificationTokens } from "@/db/schema";
import { isAdminEmail } from "@/lib/admin-emails";
import { decideSignIn } from "@/lib/auth-access";

// TRAVEL auth instance — a SEPARATE NextAuth v5 instance from the facility
// `src/auth.ts`. It shares the users/accounts/verificationTokens tables (one
// family = one record across both slices) but uses travel's OWN
// `travelSessions` table + a DISTINCT cookie, so the two auth systems are
// fully independent at storage and a browser holding both sessions can never
// confuse them. See docs/travel/integration-base.md §2 (the locked contract).
//
// This file is ADDITIVE. The facility `src/auth.ts` is not touched.

// The prod/preview cookie name (LOCKED by the contract). The `__Secure-`
// prefix requires secure:true, which holds on https (preview + prod). For a
// local NON-https dev origin the prefix would make the browser drop the
// cookie, so we fall back to an unprefixed name off-https — matching how
// Auth.js itself names the default cookie by environment. The prod/preview
// name is always "__Secure-travel-authjs.session-token".
const useSecureCookies = process.env.NODE_ENV === "production";
const travelSessionCookieName = useSecureCookies
  ? "__Secure-travel-authjs.session-token"
  : "travel-authjs.session-token";

export const {
  handlers,
  auth: uncachedAuth,
  signIn,
  signOut,
} = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    // travel's OWN session table (additive) — NOT the facility `sessions`.
    sessionsTable: travelSessions,
    verificationTokensTable: verificationTokens,
  }),
  // basePath so the travel auth endpoints live under /travel/api/auth/* (the
  // rewrite target for travel.pfaengine.com), independent of the facility
  // /api/auth. trustHost derives callback URLs from the incoming host
  // (travel.pfaengine.com) instead of a facility AUTH_URL — no travel-specific
  // AUTH_URL env is needed.
  basePath: "/travel/api/auth",
  trustHost: true,
  providers: [
    // Mirror the facility providers exactly, reusing the same env var names
    // (AUTH_GOOGLE_ID/SECRET, AUTH_RESEND_KEY). allowDangerousEmailAccountLinking
    // matches facility rationale: hardcoded admins + verified real addresses,
    // no high-value takeover target.
    Google({ allowDangerousEmailAccountLinking: true }),
    Resend({
      from: "PFA Engine <noreply@pfaengine.com>",
    }),
  ],
  session: {
    strategy: "database",
    // Mirror facility's 90-day rolling session.
    maxAge: 90 * 24 * 60 * 60,
  },
  cookies: {
    sessionToken: {
      name: travelSessionCookieName,
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        // NO `domain` → host-only, scoped to travel.pfaengine.com only.
        secure: useSecureCookies,
      },
    },
  },
  pages: {
    signIn: "/travel/signin",
  },
  callbacks: {
    // Same invite-only gate as facility (Jacob, LOCKED): a sign-in is allowed
    // only when the email is on the hardcoded admin allowlist OR a
    // non-soft-deleted user row already exists. Note: passing this gate only
    // proves the email is a known family/admin record — travel-surface access
    // is separately enforced by requireTravelAccess() (role/travelAdmin).
    async signIn({ user, profile }) {
      const email = (user?.email ?? profile?.email ?? "")
        .toLowerCase()
        .trim();
      if (!email) return false;
      if (isAdminEmail(email)) return true;

      const lookupUser = () =>
        db
          .select({ id: users.id })
          .from(users)
          .where(
            and(eq(sql`lower(${users.email})`, email), isNull(users.deletedAt)),
          )
          .limit(1);

      let rows: { id: string }[];
      try {
        rows = await lookupUser();
      } catch {
        try {
          await new Promise((resolve) => setTimeout(resolve, 150));
          rows = await lookupUser();
        } catch (retryErr) {
          Sentry.captureException(retryErr);
          return false;
        }
      }
      return decideSignIn({ email, isAdmin: false, userExists: rows.length > 0 });
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
        // Mirror facility: the hardcoded admin allowlist is authoritative for
        // the session role, so facility admins get role="admin" on travel too.
        session.user.role = isAdminEmail(session.user.email)
          ? "admin"
          : (user as { role?: "coach" | "admin" }).role ?? "coach";
        // Travel operator flag, read straight from the adapter user row
        // (database strategy). requireTravelAccess() keys off role==="admin"
        // || travelAdmin===true, so a travel-only operator gets travel access
        // without any facility `role` enum change.
        //
        // The facility `types/next-auth.d.ts` types `session.user` as a closed
        // inline intersection we don't own, so `travelAdmin` isn't a declared
        // key on it. We stamp it through a widened cast; the travel guard reads
        // it back through the matching `TravelSessionUser` view.
        (session.user as { travelAdmin?: boolean }).travelAdmin =
          (user as { travelAdmin?: boolean }).travelAdmin ?? false;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id && isAdminEmail(user.email)) {
        await db
          .update(users)
          .set({ role: "admin" })
          .where(eq(users.id, user.id));
      }
    },
  },
});

// Dedup the session read within a single request (same rationale as facility
// src/auth.ts). Only wraps the RSC/server-action session GETTER — the route
// handlers use `handlers`, not this wrapper, so caching cannot affect the
// travel auth HTTP endpoints.
export const auth: typeof uncachedAuth = cache(uncachedAuth);
