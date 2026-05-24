import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
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
  providers: [Google],
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
