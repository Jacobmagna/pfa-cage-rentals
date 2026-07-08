// Travel-owned single-use email tokens (parent claim / email-verify / reset),
// stored in the travel-native `travel_verification_tokens` table. Ports the
// Northstar single-use, namespaced, raw-in-the-link / hash-in-the-DB model
// (see northstar src/lib/server/email-token.ts) so a DB read can't be replayed
// to forge a link.
//
// SECURITY MODEL:
//   • The raw token in the email is 32 random bytes hex (256 bits).
//   • We store only its SHA-256 HASH (never the raw token). The hash is
//     deterministic so the row can be looked up directly by (identifier, hash).
//   • The identifier is NAMESPACED by the caller ("verify:<email>" /
//     "reset:<email>", lowercased) so token types never collide.
//   • One live token per identifier: issuing deletes any prior rows first.
//   • Single-use: the row is DELETED the moment a valid token is consumed.
//   • Expiry enforced on read.
//
// server-only: it mints/handles secrets.

import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { travelVerificationTokens } from "@/db/schema";

/** SHA-256 hash (hex) of a raw token. Deterministic → looked up directly. */
function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Constant-time compare of two hex hash strings; false on any mismatch. */
function hashEquals(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Issue a fresh single-use token for `identifier` (already namespaced +
 * lowercased by the caller, e.g. "verify:<email>"). Deletes any prior tokens
 * for that identifier (one live token per identifier), stores the token's
 * HASH with `expires = now + ttlMs`, and returns the RAW token for the email
 * link.
 */
export async function issueTravelToken(
  identifier: string,
  ttlMs: number,
): Promise<string> {
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expires = new Date(Date.now() + ttlMs);

  // One live token per identifier: clear any prior rows first.
  await db
    .delete(travelVerificationTokens)
    .where(eq(travelVerificationTokens.identifier, identifier));

  await db.insert(travelVerificationTokens).values({
    identifier,
    token: tokenHash,
    expires,
  });

  return rawToken;
}

/**
 * Consume a raw token for `identifier`. Hashes the raw token, looks up the row
 * by (identifier, hash), and checks it hasn't expired. On a valid, unexpired
 * match: DELETE the row (single-use) and return true. Otherwise return false.
 * Never throws on a miss.
 */
export async function consumeTravelToken(
  identifier: string,
  rawToken: string,
): Promise<boolean> {
  if (!rawToken || typeof rawToken !== "string") return false;

  const tokenHash = hashToken(rawToken);

  const rows = await db
    .select({
      token: travelVerificationTokens.token,
      expires: travelVerificationTokens.expires,
    })
    .from(travelVerificationTokens)
    .where(
      and(
        eq(travelVerificationTokens.identifier, identifier),
        eq(travelVerificationTokens.token, tokenHash),
        gt(travelVerificationTokens.expires, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  // Defense-in-depth: reconfirm the stored hash matches in constant time.
  if (!row || !hashEquals(row.token, tokenHash)) return false;

  // Single-use: delete this exact row (identifier + hash).
  await db
    .delete(travelVerificationTokens)
    .where(
      and(
        eq(travelVerificationTokens.identifier, identifier),
        eq(travelVerificationTokens.token, tokenHash),
      ),
    );

  return true;
}
