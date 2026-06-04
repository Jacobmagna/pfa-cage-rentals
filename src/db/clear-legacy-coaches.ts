// Importable, side-effect-free legacy-coach soft-delete logic.
//
// The users table holds admins + the REAL coaches seeded from
// build/seed-data/coaches.json + a set of LEGACY coach rows uploaded
// earlier that Jacob wants gone from the Coaches list. We SOFT-DELETE
// the legacy coaches (set users.deletedAt) — reversible — rather than
// hard-deleting, so the operation can be undone by clearing deletedAt.
// The admin Coaches list already filters isNull(users.deletedAt), so
// soft-deleted rows simply vanish from the UI.
//
// The KEEP set is the lowercased emails from coaches.json (passed in by
// the caller via loadCoachesFromJson()). A row is "legacy" when it is a
// role=coach, NOT-yet-soft-deleted user whose lower(email) is NOT in the
// keep-set. Admins are excluded by the role filter, so even though
// coaches.json may list an admin (drc@pfasports.com) it is never a
// target either way.
//
// This module has NO top-level side effects: importing it neither
// connects to nor mutates any database. The caller (the CLI runner or
// the integration test) supplies the `db` handle and the keep-set.

import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { users } from "./schema";
import type { db as Database } from "./index";

type Db = typeof Database;

export type LegacyCoachTarget = {
  id: string;
  name: string | null;
  email: string;
  createdAt: Date;
};

// Returns the users that would be soft-deleted: role = 'coach' AND
// deletedAt IS NULL AND lower(email) NOT IN keepEmails. Ordered by
// createdAt asc for a stable, readable preview. Compares lower(email)
// against the (already lowercased) keep-set so casing never matters.
export async function findLegacyCoaches(
  db: Db,
  keepEmails: Set<string>,
): Promise<LegacyCoachTarget[]> {
  const keep = [...keepEmails];

  // NOT IN against an empty list is always true in SQL, so guarding the
  // empty keep-set here would (incorrectly) return EVERY coach. The
  // empty-keep-set refusal lives in softDeleteLegacyCoaches; findLegacy-
  // Coaches is a read-only preview and faithfully reports that "every
  // active coach is a target" when the keep-set is empty — which is
  // exactly why the write path refuses to act on it.
  const notInKeep =
    keep.length === 0
      ? sql`true`
      : notInArray(sql`lower(${users.email})`, keep);

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(eq(users.role, "coach"), isNull(users.deletedAt), notInKeep))
    .orderBy(asc(users.createdAt));

  return rows;
}

// Soft-deletes the legacy coaches (sets deletedAt = now) for exactly the
// ids returned by findLegacyCoaches. CRITICAL SAFETY: refuses to run
// with an empty keep-set — a missing/empty coaches.json must never wipe
// every coach. Idempotent: after a run the targets have deletedAt set,
// so a re-run finds 0. Touches ONLY users.deletedAt — a single-column
// update; accounts/sessions/etc. are never touched (no FK concerns).
export async function softDeleteLegacyCoaches(
  db: Db,
  keepEmails: Set<string>,
): Promise<{ softDeleted: number; targets: LegacyCoachTarget[] }> {
  if (keepEmails.size === 0) {
    throw new Error(
      "refusing to run with an empty keep-set — would soft-delete every coach",
    );
  }

  const targets = await findLegacyCoaches(db, keepEmails);

  if (targets.length === 0) {
    return { softDeleted: 0, targets };
  }

  const ids = targets.map((t) => t.id);
  await db
    .update(users)
    .set({ deletedAt: new Date() })
    .where(inArray(users.id, ids));

  return { softDeleted: targets.length, targets };
}
