// Travel parent (guardian) auth FLOWS — composes the 2a primitives (password
// hashing, single-use email tokens, guardian sessions) into the four public
// operations the parent surface needs: sign-in, claim-and-set-password,
// request-reset, and reset. Plus `issueClaimToken`, which Block 2's invite/accept
// flow calls to mint + email a claim link.
//
// Security posture ported from Northstar's password-auth.ts (adapted to the
// travel-native schema):
//   • NO ENUMERATION on sign-in — a missing user and a wrong password BOTH
//     return the generic `invalid`, and the missing-user branch still pays the
//     scrypt cost against a fixed dummy hash so the timing profile matches.
//   • NO ENUMERATION on requestPasswordReset — it ALWAYS resolves; a link is
//     only sent when a claimed (password-set) guardian exists.
//   • Reset INVALIDATES all existing guardian sessions (force re-login
//     everywhere after a reset — defense-in-depth against a stolen session).
//   • Email is normalized (lowercased + trimmed) everywhere so lookups + token
//     namespaces are consistent.
//
// server-only: it reads/writes credentials, mints sessions + tokens, sends mail.

import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { travelGuardians, travelSessions } from "@/db/schema";
import { hashPassword, verifyPassword } from "@/travel/password";
import { consumeTravelToken, issueTravelToken } from "@/travel/tokens";
import { createTravelGuardianSession } from "@/travel/session";
import { sendClaimEmail, sendResetEmail } from "@/travel/email";

export type FlowErrorCode =
  | "invalid"
  | "unclaimed"
  | "unverified"
  | "bad_token"
  | "weak_password";

export type FlowResult = { ok: true } | { ok: false; code: FlowErrorCode };

// Minimum password length. Below this → `weak_password` (checked before any
// token consumption so a too-short password never burns a single-use token).
const MIN_PASSWORD_LENGTH = 8;

// Token namespace TTLs.
const CLAIM_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h

// A well-formed but unmatchable scrypt hash, used ONLY to keep the sign-in
// timing profile constant when no guardian exists for the email (so "no such
// user" and "wrong password" both pay the scrypt cost). It parses cleanly and
// `verifyPassword` will always return false against it. Format matches
// src/travel/password.ts: scrypt$N$r$p$saltHex$hashHex.
const DUMMY_PASSWORD_HASH =
  "scrypt$65536$8$1$00000000000000000000000000000000$" +
  "0000000000000000000000000000000000000000000000000000000000000000" +
  "0000000000000000000000000000000000000000000000000000000000000000";

/** Lowercase + trim an email for consistent lookups and token namespaces. */
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

/** The claim/verify token namespace for an email ("verify:<email>"). */
function verifyIdentifier(email: string): string {
  return `verify:${email}`;
}

/** The reset token namespace for an email ("reset:<email>"). */
function resetIdentifier(email: string): string {
  return `reset:${email}`;
}

type GuardianRow = {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerified: Date | null;
};

/** Look up a guardian by NORMALIZED email, or null. */
async function findGuardianByEmail(email: string): Promise<GuardianRow | null> {
  const rows = await db
    .select({
      id: travelGuardians.id,
      email: travelGuardians.email,
      passwordHash: travelGuardians.passwordHash,
      emailVerified: travelGuardians.emailVerified,
    })
    .from(travelGuardians)
    .where(eq(travelGuardians.email, email))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Sign a guardian in with email + password. NON-ENUMERATING: a missing guardian
 * and a wrong password BOTH return `invalid`; the missing-user branch still runs
 * a `verifyPassword` against a fixed dummy hash so both paths pay the scrypt
 * cost. An unclaimed account (no passwordHash) → `unclaimed`; a claimed but
 * unverified account (correct password, emailVerified null) → `unverified`. On
 * full success a guardian session is minted → `{ok:true}`.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<FlowResult> {
  const normalized = normalizeEmail(email);
  const guardian = await findGuardianByEmail(normalized);

  // No guardian at all: pay the scrypt cost, then generic invalid (no leak).
  if (!guardian) {
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    return { ok: false, code: "invalid" };
  }

  // A guardian that never claimed an account has no password to check.
  if (guardian.passwordHash == null) {
    return { ok: false, code: "unclaimed" };
  }

  const okPassword = await verifyPassword(password, guardian.passwordHash);
  if (!okPassword) {
    return { ok: false, code: "invalid" };
  }

  // Correct password, but the email was never verified. This only reveals the
  // unverified state to someone who already proved they know the password, so
  // it's not a meaningful enumeration leak.
  if (guardian.emailVerified == null) {
    return { ok: false, code: "unverified" };
  }

  await createTravelGuardianSession(guardian.id);
  return { ok: true };
}

/**
 * Consume a CLAIM token and set the guardian's password + mark their email
 * verified, then log them in. Validates password length first (so a weak
 * password never burns the token). A bad/expired/forged token → `bad_token`.
 * On success mints a guardian session → `{ok:true}`.
 */
export async function claimAndSetPassword(
  email: string,
  token: string,
  password: string,
): Promise<FlowResult> {
  const normalized = normalizeEmail(email);

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: "weak_password" };
  }

  const okToken = await consumeTravelToken(verifyIdentifier(normalized), token);
  if (!okToken) {
    return { ok: false, code: "bad_token" };
  }

  const guardian = await findGuardianByEmail(normalized);
  if (!guardian) {
    // The token was valid but the guardian is gone — treat as a bad token
    // rather than leaking that the account no longer exists.
    return { ok: false, code: "bad_token" };
  }

  const passwordHash = await hashPassword(password);
  await db
    .update(travelGuardians)
    .set({ passwordHash, emailVerified: new Date() })
    .where(eq(travelGuardians.id, guardian.id));

  await createTravelGuardianSession(guardian.id);
  return { ok: true };
}

/**
 * Begin a password reset. NON-ENUMERATING: ALWAYS resolves. A reset link is
 * minted + emailed ONLY when a CLAIMED (non-null passwordHash) guardian exists
 * for the email; otherwise this is a silent no-op (an unclaimed account has no
 * password to reset — it should claim instead).
 */
export async function requestPasswordReset(
  email: string,
  origin: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  const guardian = await findGuardianByEmail(normalized);
  if (!guardian || guardian.passwordHash == null) return;

  const token = await issueTravelToken(resetIdentifier(normalized), RESET_TTL_MS);
  await sendResetEmail(normalized, token, origin);
}

/**
 * Consume a RESET token and set the guardian's new password. Validates password
 * length first (so a weak password never burns the token). A bad/expired/forged
 * token → `bad_token`. On success updates the password AND invalidates every
 * existing guardian session (force re-login everywhere). Does NOT auto-login —
 * the user signs in with their new password → `{ok:true}`.
 */
export async function resetPassword(
  email: string,
  token: string,
  password: string,
): Promise<FlowResult> {
  const normalized = normalizeEmail(email);

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, code: "weak_password" };
  }

  const okToken = await consumeTravelToken(resetIdentifier(normalized), token);
  if (!okToken) {
    return { ok: false, code: "bad_token" };
  }

  const guardian = await findGuardianByEmail(normalized);
  if (!guardian) {
    // Token was valid but the guardian is gone — generic bad-token failure.
    return { ok: false, code: "bad_token" };
  }

  const passwordHash = await hashPassword(password);
  await db
    .update(travelGuardians)
    .set({ passwordHash })
    .where(eq(travelGuardians.id, guardian.id));

  // Invalidate all existing guardian sessions (defense-in-depth: a reset should
  // log out any stolen session everywhere). No auto-login.
  await db
    .delete(travelSessions)
    .where(eq(travelSessions.guardianId, guardian.id));

  return { ok: true };
}

/**
 * Mint a fresh 24h CLAIM token for an email and send the claim link. Block 2's
 * accept flow calls this to invite a parent to set up their account. No return —
 * callers show the same "check your inbox" copy regardless.
 */
export async function issueClaimToken(
  email: string,
  origin: string,
): Promise<void> {
  const normalized = normalizeEmail(email);
  const token = await issueTravelToken(
    verifyIdentifier(normalized),
    CLAIM_TTL_MS,
  );
  await sendClaimEmail(normalized, token, origin);
}
