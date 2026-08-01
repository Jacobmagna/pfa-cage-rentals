// 1b #26/27: server-only loader for the admin cancellations dashboard.
// Reads session_cancellations (the audit trail of deleted cage rentals)
// joined to the owner's name, the actor's name, and the resource name,
// then derives timing categories + per-coach pattern rollups via the
// pure helpers in src/lib/cancellation.ts.

import { aliasedTable, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { resources, sessionCancellations, users } from "@/db/schema";
import {
  categorizeCancellation,
  isConcerning,
  summarizeByCoach,
  type CancelCategory,
  type CoachCancelSummary,
} from "@/lib/cancellation";
import { CANCEL_REASON_LABELS } from "@/lib/schemas/session";

export type RecentCancellation = {
  id: string;
  sessionId: string;
  coachId: string;
  coachName: string | null;
  resourceName: string | null;
  startAt: Date;
  endAt: Date;
  cancelledAt: Date;
  leadTimeMins: number;
  category: CancelCategory;
  // true when an admin (not the rental owner) removed the rental.
  byAdmin: boolean;
  actorName: string | null;
  // Raw stored reason key (one of CANCEL_REASONS) + free-text for 'other'.
  // Null for before-cancels, admin deletes, and pre-feature rows.
  cancelReason: string | null;
  cancelReasonOther: string | null;
  // Derived human label for display: the reason's label, or the Other
  // free-text when reason='other'; null when there is no reason.
  reasonLabel: string | null;
};

// Map a stored reason (key + optional other-text) to its display string.
// 'other' shows the free-text; a known key shows its label; null/unknown → null.
function deriveReasonLabel(
  reason: string | null,
  reasonOther: string | null,
): string | null {
  if (!reason) return null;
  if (reason === "other") return reasonOther ?? null;
  return CANCEL_REASON_LABELS[reason as keyof typeof CANCEL_REASON_LABELS] ?? null;
}

export type CancellationsDashboard = {
  rollup: CoachCancelSummary[];
  recent: RecentCancellation[];
  counts: { lastMinute30d: number };
};

const RECENT_CAP = 100;

export async function loadCancellationsDashboard(opts?: {
  sinceDays?: number;
}): Promise<CancellationsDashboard> {
  const sinceDays = opts?.sinceDays ?? 90;
  const now = new Date();
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);

  // Separate aliases for the owner vs the actor (cancelledBy) join.
  const owner = aliasedTable(users, "owner");
  const actor = aliasedTable(users, "actor");

  const rows = await db
    .select({
      id: sessionCancellations.id,
      sessionId: sessionCancellations.sessionId,
      coachId: sessionCancellations.coachId,
      coachName: owner.name,
      resourceName: resources.name,
      startAt: sessionCancellations.startAt,
      endAt: sessionCancellations.endAt,
      cancelledAt: sessionCancellations.cancelledAt,
      cancelledBy: sessionCancellations.cancelledBy,
      leadTimeMins: sessionCancellations.leadTimeMins,
      cancelReason: sessionCancellations.cancelReason,
      cancelReasonOther: sessionCancellations.cancelReasonOther,
      actorName: actor.name,
    })
    .from(sessionCancellations)
    .leftJoin(owner, eq(owner.id, sessionCancellations.coachId))
    .leftJoin(actor, eq(actor.id, sessionCancellations.cancelledBy))
    .leftJoin(resources, eq(resources.id, sessionCancellations.resourceId))
    .where(gte(sessionCancellations.cancelledAt, since))
    .orderBy(desc(sessionCancellations.cancelledAt));

  const recent: RecentCancellation[] = rows.slice(0, RECENT_CAP).map((r) => {
    const category = categorizeCancellation(r.startAt, r.endAt, r.cancelledAt);
    return {
      id: r.id,
      sessionId: r.sessionId,
      coachId: r.coachId,
      coachName: r.coachName,
      resourceName: r.resourceName,
      startAt: r.startAt,
      endAt: r.endAt,
      cancelledAt: r.cancelledAt,
      leadTimeMins: r.leadTimeMins,
      category,
      byAdmin: r.cancelledBy !== r.coachId,
      actorName: r.actorName,
      cancelReason: r.cancelReason,
      cancelReasonOther: r.cancelReasonOther,
      reasonLabel: deriveReasonLabel(r.cancelReason, r.cancelReasonOther),
    };
  });

  // Rollup over ALL rows in the window (not just the 100-row recent cap),
  // owner-cancellations only (summarizeByCoach drops non-owner rows).
  const rollup = summarizeByCoach(
    rows.map((r) => ({
      coachId: r.coachId,
      coachName: r.coachName,
      ownerCancellation: r.cancelledBy === r.coachId,
      category: categorizeCancellation(r.startAt, r.endAt, r.cancelledAt),
    })),
  );

  // Hub stat: concerning OWNER cancellations in the last 30 days.
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const lastMinute30d = rows.filter((r) => {
    if (r.cancelledBy !== r.coachId) return false;
    if (r.cancelledAt < thirtyDaysAgo) return false;
    return isConcerning(
      categorizeCancellation(r.startAt, r.endAt, r.cancelledAt),
    );
  }).length;

  return { rollup, recent, counts: { lastMinute30d } };
}
