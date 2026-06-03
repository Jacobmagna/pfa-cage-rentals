// Seeds PFA's coach roster — FEAT-12 pass 2.
//
// File-decoupled by design: the roster JSON (build/seed-data/coaches.json)
// is GITIGNORED because it contains PII (names, emails, phone numbers).
// loadCoachesFromJson() returns [] when the file is absent so this module
// is safe to ship — on a fresh clone or on Vercel (where the gitignored
// file never exists) the seed simply skips coaches.
//
// Role-preserving upsert keyed on the unique `users.email`:
//   - NEW email  → INSERT { name, email, phone, role: "coach" }.
//   - EXISTING   → UPDATE name + phone ONLY. We NEVER touch `role`
//                  (so a pre-existing admin like drc@pfasports.com is
//                  never demoted to coach) and never touch deletedAt /
//                  emailVerified.
//
// Idempotent: a 2nd run inserts 0 (all emails now exist) and just
// re-updates name/phone on the existing rows.
//
// NO top-level side effects: importing this module must not connect to a
// DB or read the filesystem — that happens inside the exported functions,
// called by the seed orchestrator after dotenv loads. Does NOT print —
// the orchestrator owns logging.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { users } from "./schema";
import type { db as Database } from "./index";

export type CoachSeedInput = {
  name: string;
  email: string;
  phone: string | null;
};

const DEFAULT_JSON_PATH = "build/seed-data/coaches.json";

// Reads the coach roster JSON from `jsonPath` (default
// build/seed-data/coaches.json resolved from process.cwd()). Returns []
// if the file is absent so committed code is safe where the gitignored
// file doesn't exist. Each row is minimally validated: name is a
// non-empty string; email is a string containing "@" (lowercased
// defensively); phone is string | null.
export function loadCoachesFromJson(
  jsonPath: string = DEFAULT_JSON_PATH,
): CoachSeedInput[] {
  const resolved = path.isAbsolute(jsonPath)
    ? jsonPath
    : path.resolve(process.cwd(), jsonPath);

  if (!existsSync(resolved)) {
    return [];
  }

  const raw = readFileSync(resolved, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`loadCoachesFromJson: expected a JSON array at ${jsonPath}`);
  }

  return parsed.map((row, i) => {
    if (typeof row !== "object" || row === null) {
      throw new Error(`loadCoachesFromJson: row ${i} is not an object`);
    }
    const r = row as Record<string, unknown>;
    const name = r.name;
    const email = r.email;
    const phone = r.phone;

    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`loadCoachesFromJson: row ${i} has invalid name`);
    }
    if (typeof email !== "string" || !email.includes("@")) {
      throw new Error(`loadCoachesFromJson: row ${i} has invalid email`);
    }
    if (phone !== null && phone !== undefined && typeof phone !== "string") {
      throw new Error(
        `loadCoachesFromJson: row ${i} has invalid phone (expected string or null)`,
      );
    }

    return {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      phone: phone == null ? null : phone,
    } satisfies CoachSeedInput;
  });
}

// Role-preserving upsert keyed on users.email. New emails are inserted as
// role "coach"; existing emails get name + phone updated only (role and
// deletedAt are left untouched). Idempotent — a rerun inserts 0 and just
// re-updates the existing rows. Returns { inserted, updated }.
export async function seedCoaches(
  db: typeof Database,
  coaches: CoachSeedInput[],
): Promise<{ inserted: number; updated: number }> {
  if (coaches.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  // Dedupe the input by email defensively (last wins) so a duplicate row
  // in the JSON doesn't cause a double insert / conflicting updates.
  const byEmail = new Map<string, CoachSeedInput>();
  for (const c of coaches) {
    byEmail.set(c.email, c);
  }
  const deduped = [...byEmail.values()];
  const emails = deduped.map((c) => c.email);

  // Which of these emails already exist? Match CASE-INSENSITIVELY: an
  // existing row may store a mixed-case email (e.g. an admin who signed up
  // as "Drc@pfasports.com"), and our seed emails are lowercased. Comparing
  // lower(users.email) against the lowercased input finds that row instead
  // of missing it and inserting a duplicate lowercase row. We lowercase the
  // returned emails so the Set comparison against the (already lowercased)
  // input is correct.
  const existingRows = await db
    .select({ email: users.email })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, emails));
  const existingEmails = new Set(
    existingRows.map((r) => r.email.toLowerCase()),
  );

  const toInsert = deduped
    .filter((c) => !existingEmails.has(c.email))
    .map((c) => ({
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: "coach" as const,
    }));

  if (toInsert.length > 0) {
    await db.insert(users).values(toInsert);
  }

  // Existing emails: update name + phone ONLY. Never touch role /
  // deletedAt / emailVerified — this is what preserves an existing
  // admin's role.
  let updated = 0;
  for (const c of deduped) {
    if (!existingEmails.has(c.email)) continue;
    // Match case-insensitively so we update the REAL (possibly mixed-case)
    // row rather than missing it. c.email is already lowercased.
    await db
      .update(users)
      .set({ name: c.name, phone: c.phone })
      .where(sql`lower(${users.email}) = ${c.email}`);
    updated += 1;
  }

  return { inserted: toInsert.length, updated };
}
