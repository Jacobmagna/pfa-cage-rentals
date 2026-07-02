// QA-2 filter-chip resolution. The coach filter dropdowns on /admin/sessions
// and /admin/hour-log list ACTIVE coaches only, but both pages honor a
// coachId / coachIds URL param independently of the dropdown — so a deep-link
// (e.g. from an archived coach's detail page) can pre-filter to a coach who
// isn't in the dropdown. Without this, the active-only options can't resolve
// that id, so the chip renders as the placeholder ("All coaches") even though
// rows ARE filtered — misleading.
//
// This looks up any requested coach id that ISN'T already an active option and
// returns a matching option (label suffixed "(archived)") so the filter chip /
// select reads clearly. It intentionally does NOT filter on deletedAt beyond
// "not already active" — an id that resolves to nothing (bogus param) yields no
// extra option, and the page just shows no rows.

import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { ActiveCoach } from "@/lib/server/coaches";

/**
 * Given the active-coach options already loaded for a filter dropdown and the
 * coach ids requested via the URL, returns extra options for any requested id
 * NOT among the active ones (typically archived coaches deep-linked from their
 * detail page). Each extra option's name carries an "(archived)" suffix so the
 * chip / select reads clearly. Returns [] when every requested id is already
 * active (the common case), doing zero DB work.
 */
export async function resolveArchivedCoachOptions(
  activeCoaches: ActiveCoach[],
  requestedIds: string[],
): Promise<ActiveCoach[]> {
  if (requestedIds.length === 0) return [];
  const activeIds = new Set(activeCoaches.map((c) => c.id));
  const missing = [...new Set(requestedIds)].filter((id) => !activeIds.has(id));
  if (missing.length === 0) return [];

  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, missing));

  return rows.map((r) => ({
    id: r.id,
    // Suffix the archived coach's name so the chip is unambiguous. Fall back
    // to email when there's no name (matches the dropdown's own label logic).
    name: `${r.name ?? r.email} (archived)`,
    email: r.email,
  }));
}
