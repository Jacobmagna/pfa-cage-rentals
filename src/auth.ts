import { cache } from "react";
import * as Sentry from "@sentry/nextjs";
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { isAdminEmail } from "@/lib/admin-emails";
import { decideSignIn } from "@/lib/auth-access";

export const { handlers, auth: uncachedAuth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  providers: [
    // allowDangerousEmailAccountLinking: a user who already exists via the
    // other provider (e.g. magic-link first, then Google) gets the new
    // account auto-linked to their existing user row by matching email,
    // instead of being rejected with OAuthAccountNotLinked. Safe for our
    // trust model: admin emails are hardcoded, coaches use real verified
    // addresses, and there's no high-value takeover target here.
    Google({ allowDangerousEmailAccountLinking: true }),
    Resend({
      // Sender lives on the PFA-dedicated Resend account
      // (jacob+pfa@themagnas.com — separate from doc-insured). See
      // docs/operations/resend-setup.md for the account-creation + domain-verification
      // runbook. AUTH_RESEND_KEY must be the API key from THAT account.
      from: "PFA Sports Academy <noreply@pfaengine.com>",
      // (no allowDangerousEmailAccountLinking — Email providers always
      // require the link-click to prove email ownership, so Auth.js handles
      // the linking flow safely without an opt-in.)
    }),
  ],
  session: {
    strategy: "database",
    // 90-day rolling sessions (Jacob): sign-in lasts ~3 months so
    // coaches/admins rarely re-authenticate. Auth.js extends the session
    // on use (default updateAge 24h). Applies to the session row + cookie.
    maxAge: 90 * 24 * 60 * 60,
  },
  pages: {
    signIn: "/",
  },
  callbacks: {
    // Invite-only gate (Jacob, LOCKED). A sign-in (Google or magic
    // link) is allowed ONLY when the email is on the hardcoded admin
    // allowlist OR a non-soft-deleted user row already exists for it.
    // Any other email is rejected here. This closes the open-signup
    // gap: previously any Google account became a coach (default role)
    // and could view minor athletes' rosters. We match on EMAIL ONLY,
    // never name.
    //
    // Correctness:
    //  - A SEEDED coach's first Google login: their users row already
    //    exists (by email) with no linked account yet → the lookup
    //    finds it → allowed → allowDangerousEmailAccountLinking then
    //    links the Google account. Existing admins/coaches keep working.
    //  - A SOFT-DELETED (purged) coach: deletedAt is set → excluded by
    //    isNull(...) → rejected (desired; re-authorize via Add coach).
    //  - Returning false makes Auth.js redirect to the sign-in page
    //    with ?error=AccessDenied and (for the email provider) does NOT
    //    send a magic link to a non-allowed address.
    //  - Admins bypass the DB call via isAdminEmail, so a transient DB
    //    error never locks admins out.
    async signIn({ user, profile }) {
      const email = (user?.email ?? profile?.email ?? "")
        .toLowerCase()
        .trim();
      if (!email) return false;
      if (isAdminEmail(email)) return true;

      // Resilience for the onboarding surge: a transient neon-http blip on
      // this lookup would throw → NextAuth bounces the coach to ?error.
      // Retry the (idempotent, read-only) lookup ONCE after a short pause.
      // If BOTH attempts fail we fail CLOSED (deny — never grant access on
      // a DB error) but capture to Sentry so the outage is visible.
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
        session.user.role = (user as { role?: "coach" | "admin" }).role ?? "coach";
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

// Dedup the session read within a single request. NextAuth v5 (beta) does
// NOT wrap auth() in React cache(), so every page issues 2+ identical
// session DB lookups (layout AppShell + page guard). React cache() is
// per-request and the session read is idempotent, so this collapses them
// to one DB hit per request without changing behavior.
//
// SAFETY: this only wraps the RSC / server-action session GETTER. The
// route handlers (src/app/api/auth/[...nextauth]/route.ts) use `handlers`,
// NOT `auth` as a wrapper, so caching the getter cannot affect the auth
// HTTP endpoints. Signature is preserved as the no-arg getter overload.
export const auth: typeof uncachedAuth = cache(uncachedAuth);
