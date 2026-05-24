import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, accounts, sessions, verificationTokens } from "@/db/schema";
import { isAdminEmail } from "@/lib/admin-emails";

export const { handlers, auth, signIn, signOut } = NextAuth({
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
      // docs/resend-setup.md for the account-creation + domain-verification
      // runbook. AUTH_RESEND_KEY must be the API key from THAT account.
      from: "PFA Cage Rentals <noreply@pfacagerentals.com>",
      // (no allowDangerousEmailAccountLinking — Email providers always
      // require the link-click to prove email ownership, so Auth.js handles
      // the linking flow safely without an opt-in.)
    }),
  ],
  session: { strategy: "database" },
  pages: {
    signIn: "/",
  },
  callbacks: {
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
