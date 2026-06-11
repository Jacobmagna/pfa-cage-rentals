// 1b add-on — server-only loader for the Coach Accountability scorecard.
//
// Aggregates 4 per-coach accountability signals over a 90-day window into one
// row per ACTIVE coach, plus a unified newest-first "recent events" feed.
// NO migration: everything derives from existing tables + session_cancellations.
//
// Signal sources (each REUSES existing logic — nothing is reinvented here):
//   • late cancels — summarizeByCoach / categorizeCancellation over
//     session_cancellations (#26/27, src/lib/cancellation.ts).
//   • no-shows     — countNoShowsByCoach (src/lib/server/needs-review.ts),
//     which mirrors the Needs-review no-show derivation but over 90 days and
//     INCLUDING acked no_shows (an acknowledged no-show still happened).
//   • late logs    — hour_logs where isLateLog(createdAt, endAt).
//   • over-logged  — hour_logs matched to their scheduled block via the
//     shared matchLogToBlock matcher, where isOverLogged(...).

import {
  aliasedTable,
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
} from "drizzle-orm";
import { db } from "@/db";
import {
  coachPayments,
  hourLogs,
  programBlockCoachFlags,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  resources,
  sessionCancellations,
  sessionsBilling,
  users,
} from "@/db/schema";
import {
  buildScorecard,
  isLateLog,
  isOverLogged,
  type CoachScorecardRow,
  type CoachSignalCounts,
} from "@/lib/accountability";
import {
  computeAging,
  type OverdueReason,
} from "@/lib/ar-aging";
import { totalFromSnapshot } from "@/lib/billing";
import {
  categorizeCancellation,
  summarizeByCoach,
  type CoachCancelSummary,
} from "@/lib/cancellation";
import { isLogScheduled } from "@/lib/coach-hour-log";
import {
  countNoShowsByCoach,
  noShowDueAt,
} from "@/lib/server/needs-review";
import {
  matchLogToBlock,
  type ReconBlock,
  type ReconCoach,
} from "@/lib/server/reconciliation";

export type AccountabilityEventKind =
  | "late_cancel"
  | "late_log"
  | "over_logged"
  | "no_show";

export type AccountabilityEvent = {
  kind: AccountabilityEventKind;
  coachId: string;
  coachName: string | null;
  when: Date;
  detail: string;
};

export type AccountabilityScorecard = {
  rows: CoachScorecardRow[];
  recent: AccountabilityEvent[];
  window: { sinceDays: number };
  totals: { coachesFlagged: number; totalConcerns: number };
};

const RECENT_CAP = 50;

export async function loadAccountabilityScorecard(opts?: {
  sinceDays?: number;
}): Promise<AccountabilityScorecard> {
  const sinceDays = opts?.sinceDays ?? 90;
  const now = new Date();
  const since = new Date(now.getTime() - sinceDays * 24 * 60 * 60 * 1000);

  // --- active coaches (id + name) ---
  const activeCoaches = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(and(eq(users.role, "coach"), isNull(users.deletedAt)));

  // --- late cancels: owner-cancellation rollup over the window ---
  const owner = aliasedTable(users, "owner");
  const cancelRows = await db
    .select({
      coachId: sessionCancellations.coachId,
      coachName: owner.name,
      resourceName: resources.name,
      startAt: sessionCancellations.startAt,
      endAt: sessionCancellations.endAt,
      cancelledAt: sessionCancellations.cancelledAt,
      cancelledBy: sessionCancellations.cancelledBy,
    })
    .from(sessionCancellations)
    .leftJoin(owner, eq(owner.id, sessionCancellations.coachId))
    .leftJoin(resources, eq(resources.id, sessionCancellations.resourceId))
    .where(gte(sessionCancellations.cancelledAt, since));

  const cancelSummary: CoachCancelSummary[] = summarizeByCoach(
    cancelRows.map((r) => ({
      coachId: r.coachId,
      coachName: r.coachName,
      ownerCancellation: r.cancelledBy === r.coachId,
      category: categorizeCancellation(r.startAt, r.endAt, r.cancelledAt),
    })),
  );
  const cancelByCoach = new Map(cancelSummary.map((s) => [s.coachId, s]));

  // --- no-shows: 90-day per-coach count (acked included) ---
  const noShowByCoach = await countNoShowsByCoach(now, sinceDays);

  // --- logs in window (drives late-log + over-logged). Join names so the
  //     recent feed has them without a second lookup. ---
  const logRows = await db
    .select({
      id: hourLogs.id,
      coachId: hourLogs.coachId,
      coachName: users.name,
      coachEmail: users.email,
      programId: hourLogs.programId,
      programName: programs.name,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
      createdAt: hourLogs.createdAt,
    })
    .from(hourLogs)
    .innerJoin(users, eq(hourLogs.coachId, users.id))
    .innerJoin(programs, eq(hourLogs.programId, programs.id))
    // 1b security B: held logs don't feed the late/over-logged feed.
    .where(and(eq(hourLogs.status, "posted"), gte(hourLogs.endAt, since)))
    .orderBy(asc(hourLogs.startAt));

  // Scheduled blocks overlapping the same window — built into ReconBlock[]
  // exactly like fetchHourLogRowsWithScheduleNotes, so matchLogToBlock (the
  // shared matcher) chooses the same block for over-logged detection.
  const blockRows = await db
    .select({
      id: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      scheduledCoachId: programScheduleBlocks.scheduledCoachId,
      coachName: users.name,
      coachEmail: users.email,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    // QA-R2 #10: LEFT join so coachless (Unassigned) blocks still appear.
    .leftJoin(users, eq(programScheduleBlocks.scheduledCoachId, users.id))
    .where(
      and(
        lt(programScheduleBlocks.startAt, now),
        gt(programScheduleBlocks.endAt, since),
      ),
    );

  const blockIds = blockRows.map((b) => b.id);
  const blockCoachRows =
    blockIds.length > 0
      ? await db
          .select({
            blockId: programScheduleBlockCoaches.blockId,
            coachId: programScheduleBlockCoaches.coachId,
            coachName: users.name,
            coachEmail: users.email,
          })
          .from(programScheduleBlockCoaches)
          .innerJoin(users, eq(programScheduleBlockCoaches.coachId, users.id))
          .where(inArray(programScheduleBlockCoaches.blockId, blockIds))
      : [];
  const coachesByBlock = new Map<string, ReconCoach[]>();
  for (const r of blockCoachRows) {
    const list = coachesByBlock.get(r.blockId) ?? [];
    list.push({ coachId: r.coachId, coachName: r.coachName ?? r.coachEmail });
    coachesByBlock.set(r.blockId, list);
  }

  const blocks: ReconBlock[] = blockRows.map((b) => {
    // QA-R2 #10: a coachless (Unassigned) block has no primary + empty set.
    const primary =
      b.scheduledCoachId !== null
        ? {
            coachId: b.scheduledCoachId,
            coachName: b.coachName ?? b.coachEmail ?? b.scheduledCoachId,
          }
        : null;
    const list = coachesByBlock.get(b.id);
    const coaches =
      primary === null
        ? (list ?? [])
        : !list || list.length === 0
          ? [primary]
          : [primary, ...list.filter((c) => c.coachId !== b.scheduledCoachId)];
    return {
      id: b.id,
      programId: b.programId,
      scheduledCoachId: b.scheduledCoachId,
      scheduledCoachName: primary?.coachName ?? null,
      coaches,
      startAt: b.startAt,
      endAt: b.endAt,
    };
  });

  // --- late logs + over-logged: count per coach, collect recent events ---
  // NOTE: right after a fresh `db:seed`, seeded hour_logs have a createdAt of
  // seed-time vs a past endAt, so they read as "late" (createdAt − endAt > 24h).
  // That's a known demo-data artifact, not a real accountability signal — the
  // counts are only meaningful for coach-entered logs in production.
  const lateLogByCoach = new Map<string, number>();
  const overLoggedByCoach = new Map<string, number>();
  const lateLogEvents: AccountabilityEvent[] = [];
  const overLoggedEvents: AccountabilityEvent[] = [];

  for (const log of logRows) {
    const coachName = log.coachName ?? log.coachEmail;

    if (isLateLog(log.createdAt, log.endAt)) {
      lateLogByCoach.set(
        log.coachId,
        (lateLogByCoach.get(log.coachId) ?? 0) + 1,
      );
      lateLogEvents.push({
        kind: "late_log",
        coachId: log.coachId,
        coachName,
        when: log.createdAt,
        detail: `Logged ${log.programName} hours late (after the session ended).`,
      });
    }

    // Over-logged only applies to logs that match a scheduled block;
    // unscheduled logs can't be "over the scheduled duration".
    const block = matchLogToBlock(
      {
        coachId: log.coachId,
        programId: log.programId,
        startAt: log.startAt,
        endAt: log.endAt,
      },
      blocks,
    );
    if (
      block &&
      isOverLogged(log.startAt, log.endAt, block.startAt, block.endAt)
    ) {
      overLoggedByCoach.set(
        log.coachId,
        (overLoggedByCoach.get(log.coachId) ?? 0) + 1,
      );
      overLoggedEvents.push({
        kind: "over_logged",
        coachId: log.coachId,
        coachName,
        when: log.startAt,
        detail: `Logged more ${log.programName} time than was scheduled.`,
      });
    }
  }

  // --- scorecard rows: one per active coach ---
  const perCoach: CoachSignalCounts[] = activeCoaches.map((c) => {
    const cancel = cancelByCoach.get(c.id);
    const lateCancels = cancel ? cancel.lastMinute + cancel.midSession : 0;
    return {
      coachId: c.id,
      coachName: c.name ?? c.email,
      noShows: noShowByCoach.get(c.id) ?? 0,
      lateCancels,
      lateCancelRatePct: cancel?.lateRatePct ?? 0,
      repeatCanceller: cancel?.repeatOffender ?? false,
      lateLogs: lateLogByCoach.get(c.id) ?? 0,
      overLogged: overLoggedByCoach.get(c.id) ?? 0,
    };
  });
  const rows = buildScorecard(perCoach);

  // --- recent unified events feed (newest-first, cap ~50) ---
  const cancelEvents: AccountabilityEvent[] = cancelRows
    .filter((r) => r.cancelledBy === r.coachId)
    .map((r) => ({
      kind: "late_cancel" as const,
      coachId: r.coachId,
      coachName: r.coachName,
      when: r.cancelledAt,
      detail: `Cancelled ${r.resourceName ?? "a rental"} (${categorizeCancellation(
        r.startAt,
        r.endAt,
        r.cancelledAt,
      ).replace("_", " ")}).`,
    }));

  const noShowEvents: AccountabilityEvent[] = await buildNoShowEvents(
    now,
    sinceDays,
    noShowByCoach,
  );

  const recent = [
    ...cancelEvents,
    ...lateLogEvents,
    ...overLoggedEvents,
    ...noShowEvents,
  ]
    .sort((a, b) => b.when.getTime() - a.when.getTime())
    .slice(0, RECENT_CAP);

  // --- totals ---
  const coachesFlagged = rows.filter((r) => r.totalConcerns > 0).length;
  const totalConcerns = rows.reduce((sum, r) => sum + r.totalConcerns, 0);

  return {
    rows,
    recent,
    window: { sinceDays },
    totals: { coachesFlagged, totalConcerns },
  };
}

/**
 * Build per-block no-show events for the recent feed. Unlike the per-coach
 * COUNT (countNoShowsByCoach), the feed wants the individual block + program
 * + time of each no-show, so we re-derive at block granularity here, reusing
 * the same membership/log/flag fetches. `noShowByCoach` is passed only to
 * short-circuit when there were no no-shows at all.
 */
async function buildNoShowEvents(
  now: Date,
  sinceDays: number,
  noShowByCoach: Map<string, number>,
): Promise<AccountabilityEvent[]> {
  if (noShowByCoach.size === 0) return [];
  const windowStart = new Date(now.getTime() - sinceDays * 24 * 60 * 60_000);

  const candidates = await db
    .select({
      blockId: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      programName: programs.name,
      coachId: programScheduleBlockCoaches.coachId,
      coachName: users.name,
      coachEmail: users.email,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .innerJoin(
      programScheduleBlockCoaches,
      eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
    )
    .innerJoin(programs, eq(programs.id, programScheduleBlocks.programId))
    .innerJoin(users, eq(users.id, programScheduleBlockCoaches.coachId))
    .where(
      and(
        gte(programScheduleBlocks.endAt, windowStart),
        lt(programScheduleBlocks.endAt, now),
      ),
    );

  if (candidates.length === 0) return [];

  const coachIds = [...new Set(candidates.map((c) => c.coachId))];
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .where(
      and(
        // 1b security B: a held log must NOT suppress a no-show in the feed.
        eq(hourLogs.status, "posted"),
        inArray(hourLogs.coachId, coachIds),
        gte(hourLogs.startAt, windowStart),
      ),
    );

  const logsByCoach = new Map<
    string,
    { programId: string; startMs: number; endMs: number }[]
  >();
  for (const log of logRows) {
    const list = logsByCoach.get(log.coachId) ?? [];
    list.push({
      programId: log.programId,
      startMs: log.startAt.getTime(),
      endMs: log.endAt.getTime(),
    });
    logsByCoach.set(log.coachId, list);
  }

  // Fetch flags for these candidate blocks so we can exclude cancelled
  // (told-us-in-advance) pairs, matching countNoShowsByCoach.
  const blockIds = [...new Set(candidates.map((c) => c.blockId))];
  const flagRows = await db
    .select({
      blockId: programBlockCoachFlags.blockId,
      coachId: programBlockCoachFlags.coachId,
      kind: programBlockCoachFlags.kind,
    })
    .from(programBlockCoachFlags)
    .where(inArray(programBlockCoachFlags.blockId, blockIds));
  const cancelledKeys = new Set<string>();
  for (const f of flagRows) {
    if (f.kind === "cancelled") cancelledKeys.add(`${f.blockId}:${f.coachId}`);
  }

  const events: AccountabilityEvent[] = [];
  const nowMs = now.getTime();
  for (const c of candidates) {
    if (nowMs < noShowDueAt(c.endAt).getTime()) continue;
    if (cancelledKeys.has(`${c.blockId}:${c.coachId}`)) continue;
    const scheduled = isLogScheduled(
      {
        programId: c.programId,
        startMs: c.startAt.getTime(),
        endMs: c.endAt.getTime(),
      },
      logsByCoach.get(c.coachId) ?? [],
    );
    if (scheduled) continue;
    events.push({
      kind: "no_show",
      coachId: c.coachId,
      coachName: c.coachName ?? c.coachEmail,
      when: c.endAt,
      detail: `No-show for scheduled ${c.programName}.`,
    });
  }
  return events;
}

// --- Overdue cage-balance / AR aging (1b security C) -------------------------
//
// Surfaces coaches who owe PFA for rentals and are past the locked policy
// thresholds (balance > $350 OR oldest unpaid rental > 30 days). The balance
// math is IDENTICAL to /admin/payments: lifetime cage owed (each rental's
// totalFromSnapshot) minus that coach's CONFIRMED, non-deleted payments.
// Program/work pay is a payout in the other direction and is intentionally
// NOT part of this balance. Pure thresholding/FIFO lives in src/lib/ar-aging.

export type OverdueRow = {
  coachId: string;
  coachName: string | null;
  balanceCents: number;
  oldestUnpaidAt: Date | null;
  oldestUnpaidDays: number;
  reasons: OverdueReason[];
};

export type OverdueBalancesResult = {
  rows: OverdueRow[]; // only overdue coaches, biggest balance first
  count: number;
};

export async function loadOverdueBalances(opts?: {
  now?: Date;
}): Promise<OverdueBalancesResult> {
  const now = opts?.now ?? new Date();

  // Run the three independent reads in parallel.
  const [activeCoaches, sessionRows, confirmedPaymentRows] = await Promise.all([
    // Active coaches — same filter as /admin/payments.
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt))),
    // Every cage rental (resource receivable). startAt drives FIFO aging.
    db
      .select({
        coachId: sessionsBilling.coachId,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling),
    // Confirmed, non-deleted payments — mirrors /admin/payments EXACTLY.
    db
      .select({
        coachId: coachPayments.coachId,
        amountCents: coachPayments.amountCents,
      })
      .from(coachPayments)
      .where(
        and(
          isNull(coachPayments.deletedAt),
          eq(coachPayments.status, "confirmed"),
        ),
      ),
  ]);

  // Per-coach rental list (each carrying its owed cents off the snapshot) so
  // computeAging can run its FIFO oldest-unpaid walk over real rental dates.
  const rentalsByCoach = new Map<string, { startAt: Date; owedCents: number }[]>();
  for (const s of sessionRows) {
    const owedCents = totalFromSnapshot(s.startAt, s.endAt, s.ratePer30MinCents);
    const list = rentalsByCoach.get(s.coachId) ?? [];
    list.push({ startAt: s.startAt, owedCents });
    rentalsByCoach.set(s.coachId, list);
  }

  const paidByCoach = new Map<string, number>();
  for (const p of confirmedPaymentRows) {
    paidByCoach.set(p.coachId, (paidByCoach.get(p.coachId) ?? 0) + p.amountCents);
  }

  const rows: OverdueRow[] = [];
  for (const c of activeCoaches) {
    const aging = computeAging(
      rentalsByCoach.get(c.id) ?? [],
      paidByCoach.get(c.id) ?? 0,
      now,
    );
    if (!aging.overdue) continue;
    rows.push({
      coachId: c.id,
      coachName: c.name ?? c.email,
      balanceCents: aging.balanceCents,
      oldestUnpaidAt: aging.oldestUnpaidAt,
      oldestUnpaidDays: aging.oldestUnpaidDays,
      reasons: aging.reasons,
    });
  }
  rows.sort((a, b) => b.balanceCents - a.balanceCents);

  return { rows, count: rows.length };
}
