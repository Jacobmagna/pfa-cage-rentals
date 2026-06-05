// Canonical active-coaches list for every coach-picker dropdown.
//
// "Active coach" = role === "coach" AND not soft-deleted. This is the
// ONE place that definition lives. Every coach <select> in the admin UI
// (schedule, reports, hour-log, hour-log/schedule, sessions dialog +
// sessions filter, import mapping) routes through here so the lists can
// never drift apart again.
//
// Why this exists: two surfaces (sessions dialog, import mapping) used
// to filter on `isNull(deletedAt)` ONLY — no role filter — so their
// dropdowns leaked admins, name-less accounts (rendered as raw emails),
// and duplicates. Centralizing the query fixes those and prevents
// regressions.
//
// Intentionally NOT routed through here (different shape / different
// semantics — leave them on their own queries):
//   - payments/page.tsx       → selects an extra `zelleContact` column
//   - coaches/page.tsx        → selects `createdAt`; drives the LIST table
//   - audit/page.tsx          → role IN (admin, coach) AND includes deleted
//                               (audit history must show everyone)
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";

export type ActiveCoach = {
  id: string;
  name: string | null;
  email: string;
};

/**
 * All active coaches for picker dropdowns, ordered by name then email.
 * Active = `role === "coach"` AND `deletedAt IS NULL`.
 */
export function listActiveCoaches(): Promise<ActiveCoach[]> {
  return db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
    .orderBy(asc(users.name), asc(users.email));
}
