"use server";

// Read-only availability action for the coach session form.
// Returns the day's bookings (sessions + blocks) joined with the
// minimum identity needed to render the in-form calendar strip
// (coach first name on each session, block reason on each block).
//
// Gated by requireSession — any signed-in user can see who's booked
// what. That's consistent with how the admin schedule grid already
// exposes the same info, and is necessary for the "I see Mike has
// Cage 1 at 2 PM, I'll text him about a swap" workflow that this
// feature exists to enable.
//
// Soft-deleted coaches show as "Former coach" via the same join the
// admin grid uses — see src/db/schema.ts deletedAt notes.

import { and, asc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/db";
import {
  blockedTimes,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { parsePfaInput, pfaDayEnd, pfaDayStart } from "@/lib/timezone";

export type AvailabilitySession = {
  id: string;
  resourceId: string;
  coachFirstName: string;
  coachId: string;
  startAt: string; // ISO
  endAt: string;
};

export type AvailabilityBlock = {
  id: string;
  resourceId: string;
  reason: string;
  startAt: string;
  endAt: string;
};

export type DayAvailability = {
  date: string; // YYYY-MM-DD echoed back
  sessions: AvailabilitySession[];
  blocks: AvailabilityBlock[];
};

function firstName(full: string | null, email: string): string {
  const candidate = full?.trim() ?? "";
  if (candidate.length > 0) {
    return candidate.split(/\s+/)[0];
  }
  // Fall back to the local-part of the email, capped so super long
  // addresses don't blow the strip's label width.
  return email.split("@")[0].slice(0, 12);
}

/**
 * Returns sessions + blocks for the given PFA-local date. Bad date
 * strings return an empty availability object rather than throwing
 * — the strip should fail soft, not break the form.
 */
export async function getDayAvailability(
  date: string,
): Promise<DayAvailability> {
  await requireSession();

  const parsed = parsePfaInput(date, "00:00");
  if (Number.isNaN(parsed.getTime())) {
    return { date, sessions: [], blocks: [] };
  }
  const dayStart = pfaDayStart(parsed);
  const dayEnd = pfaDayEnd(parsed);

  const [sessionRows, blockRows] = await Promise.all([
    db
      .select({
        id: sessionsBilling.id,
        resourceId: sessionsBilling.resourceId,
        coachId: sessionsBilling.coachId,
        coachName: users.name,
        coachEmail: users.email,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
      })
      .from(sessionsBilling)
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .where(
        // True half-open overlap (matches the codebase's overlap semantics,
        // e.g. program-resource-blocks): catches a row straddling midnight
        // from the prior PFA day. start < dayEnd AND end > dayStart.
        and(
          lt(sessionsBilling.startAt, dayEnd),
          gt(sessionsBilling.endAt, dayStart),
        ),
      )
      .orderBy(asc(sessionsBilling.startAt)),
    db
      .select({
        id: blockedTimes.id,
        resourceId: blockedTimes.resourceId,
        reason: blockedTimes.reason,
        startAt: blockedTimes.startAt,
        endAt: blockedTimes.endAt,
      })
      .from(blockedTimes)
      // No isNull(resourceId) check needed — blockedTimes.resourceId is
      // notNull at the schema level. We do need to scope by date.
      .innerJoin(resources, eq(blockedTimes.resourceId, resources.id))
      .where(
        // True half-open overlap (see the sessions query above): catches a
        // blocked_times / program-occupancy row that starts the prior PFA day
        // and ends after midnight. start < dayEnd AND end > dayStart.
        and(
          lt(blockedTimes.startAt, dayEnd),
          gt(blockedTimes.endAt, dayStart),
        ),
      )
      .orderBy(asc(blockedTimes.startAt)),
  ]);

  return {
    date,
    sessions: sessionRows.map((r) => ({
      id: r.id,
      resourceId: r.resourceId,
      coachId: r.coachId,
      coachFirstName: firstName(r.coachName, r.coachEmail),
      startAt: r.startAt.toISOString(),
      endAt: r.endAt.toISOString(),
    })),
    blocks: blockRows.map((b) => ({
      id: b.id,
      resourceId: b.resourceId,
      reason: b.reason,
      startAt: b.startAt.toISOString(),
      endAt: b.endAt.toISOString(),
    })),
  };
}
