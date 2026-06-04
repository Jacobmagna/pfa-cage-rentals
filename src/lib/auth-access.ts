// Pure sign-in decision helper — no DB, no NextAuth types, so it's
// trivially unit-testable and the real signIn callback in src/auth.ts
// stays a thin wrapper around a DB lookup + this decision.
//
// Invite-only model (Jacob, LOCKED): a Google/email sign-in is allowed
// only when the email is on the hardcoded admin allowlist OR a
// non-soft-deleted user row already exists for it. This closes the
// open-signup gap where any Google account became a coach (default
// role) and could view minor athletes' rosters. We check EMAIL ONLY,
// never name.
export function decideSignIn(opts: {
  email: string | null | undefined;
  isAdmin: boolean;
  userExists: boolean;
}): boolean {
  const email = (opts.email ?? "").trim();
  if (!email) return false;
  return opts.isAdmin || opts.userExists;
}
