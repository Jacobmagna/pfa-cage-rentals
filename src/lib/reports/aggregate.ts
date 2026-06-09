// Pure aggregation for billing reports. No DB, no React, no I/O.
// Both the live admin preview and the ExcelJS export call this —
// single source of truth for what a "report row" looks like.
//
// Snapshot rule (post variable-rates change): every session input
// already carries its own `ratePer30MinCents`, stamped at session
// creation by the server actions. This aggregator NEVER recomputes
// from current overrides — it multiplies snapshot rate × slot count
// so reports always reflect the historical rate at the time of the
// booking, even if Dad has since renegotiated the coach's rate.
//
// Cents discipline: every monetary number stays in integer cents.

import {
  slotsBetween,
  totalFromSnapshot,
  type ResourceType,
} from "@/lib/billing";
import {
  formatPfaDate,
  formatPfaTime,
  formatPfaWeekday,
} from "@/lib/timezone";

export type AggregateSessionInput = {
  sessionId: string;
  coachId: string;
  coachName: string | null;
  coachEmail: string;
  resourceId: string;
  resourceName: string;
  resourceType: ResourceType;
  startAt: Date;
  endAt: Date;
  note: string | null;
  /** Cents-per-30-min rate stamped on the session row at creation. */
  ratePer30MinCents: number;
};

/**
 * A program-hour log contributes to a coach's payroll alongside cage /
 * bullpen / weight-room sessions, but it isn't a resource booking — it
 * has no resourceType and never appears in the session detail table.
 * It rolls up into the summary's "Program hours" category only.
 */
export type AggregateHourLogInput = {
  coachId: string;
  coachName: string | null;
  coachEmail: string;
  startAt: Date;
  endAt: Date;
  /**
   * Cents-per-30-min rate snapshotted at log time. NULLABLE — pre-rate
   * logs stay null and contribute $0; callers pass `?? 0`.
   */
  ratePer30MinCents: number;
};

export type DetailRow = {
  sessionId: string;
  date: string;          // YYYY-MM-DD, local TZ
  dayOfWeek: string;     // "Mon"
  startTime: string;     // "09:00"
  endTime: string;       // "10:30"
  durationMinutes: number;
  slots: number;
  resourceName: string;
  resourceType: ResourceType;
  coachId: string;
  coachName: string;     // Display name; falls back to email if null
  coachEmail: string;
  ratePerSlotCents: number;
  totalCents: number;
  note: string | null;
};

export type SummaryRow = {
  coachId: string;
  coachName: string;
  coachEmail: string;
  cageSlots: number;
  cageTotalCents: number;
  bullpenSlots: number;
  bullpenTotalCents: number;
  weightRoomSlots: number;
  weightRoomTotalCents: number;
  /** Program-hour slots logged in range (additive; never a resource type). */
  programSlots: number;
  programTotalCents: number;
  /**
   * Cage-side receivable subtotal (cage + bullpen + weight_room) — money the
   * coach OWES PFA. Does NOT include program pay (a payout in the opposite
   * direction); program pay lives in `programTotalCents`. The two money
   * directions are never summed.
   */
  totalCents: number;
};

export type ReportData = {
  detail: DetailRow[];
  summary: SummaryRow[];
  /** Cage-side receivable grand total (sum of detail rows) — coach owes PFA. */
  grandTotalCents: number;
  /** Program-pay grand total — PFA owes the coach. Never summed with cage. */
  programGrandTotalCents: number;
};

/**
 * Turns raw session inputs into the canonical report shape. Detail
 * is in the input order (caller should pre-sort by date); Summary
 * is sorted by coach name for stable UI / Excel output.
 *
 * Reads `ratePer30MinCents` straight off each input row — never
 * recomputes.
 *
 * `hourLogs` (optional) are program-hour entries: they roll into each
 * coach's summary as the "Program hours" category (`programTotalCents`)
 * and into `programGrandTotalCents`, but NEVER into the cage-side
 * `totalCents` / `grandTotalCents` — program pay is a payout, the opposite
 * money direction from the cage receivable, and the two are never summed.
 * They also never appear in the session detail table (not resource bookings).
 */
export function aggregateReport(
  sessions: AggregateSessionInput[],
  hourLogs: AggregateHourLogInput[] = [],
): ReportData {
  const detail: DetailRow[] = sessions.map((s) => {
    const slots = slotsBetween(s.startAt, s.endAt);
    const totalCents = slots * s.ratePer30MinCents;
    return {
      sessionId: s.sessionId,
      date: formatPfaDate(s.startAt),
      dayOfWeek: formatPfaWeekday(s.startAt),
      startTime: formatPfaTime(s.startAt),
      endTime: formatPfaTime(s.endAt),
      durationMinutes: Math.round(
        (s.endAt.getTime() - s.startAt.getTime()) / 60_000,
      ),
      slots,
      resourceName: s.resourceName,
      resourceType: s.resourceType,
      coachId: s.coachId,
      coachName: s.coachName ?? s.coachEmail,
      coachEmail: s.coachEmail,
      ratePerSlotCents: s.ratePer30MinCents,
      totalCents,
      note: s.note,
    };
  });

  // Roll detail rows up per coach. Map keyed by coachId for O(1)
  // upsert; converted to array + sorted at the end.
  const summaryMap = new Map<string, SummaryRow>();
  // Upsert helper so the session loop and the program-hour loop share
  // one initializer — a coach who only logged program hours (no
  // resource sessions) still gets a summary row.
  const ensureEntry = (
    coachId: string,
    coachName: string,
    coachEmail: string,
  ): SummaryRow => {
    let entry = summaryMap.get(coachId);
    if (!entry) {
      entry = {
        coachId,
        coachName,
        coachEmail,
        cageSlots: 0,
        cageTotalCents: 0,
        bullpenSlots: 0,
        bullpenTotalCents: 0,
        weightRoomSlots: 0,
        weightRoomTotalCents: 0,
        programSlots: 0,
        programTotalCents: 0,
        totalCents: 0,
      };
      summaryMap.set(coachId, entry);
    }
    return entry;
  };
  for (const row of detail) {
    const entry = ensureEntry(row.coachId, row.coachName, row.coachEmail);
    switch (row.resourceType) {
      case "cage":
        entry.cageSlots += row.slots;
        entry.cageTotalCents += row.totalCents;
        break;
      case "bullpen":
        entry.bullpenSlots += row.slots;
        entry.bullpenTotalCents += row.totalCents;
        break;
      case "weight_room":
        entry.weightRoomSlots += row.slots;
        entry.weightRoomTotalCents += row.totalCents;
        break;
    }
    entry.totalCents += row.totalCents;
  }

  // Fold program hours into the same per-coach summary as an additive
  // "Program hours" category. Snapshot rate × slot count, same as
  // sessions; null snapshots already arrive as 0 from the caller.
  let programGrandTotalCents = 0;
  for (const log of hourLogs) {
    const entry = ensureEntry(
      log.coachId,
      log.coachName ?? log.coachEmail,
      log.coachEmail,
    );
    const slots = slotsBetween(log.startAt, log.endAt);
    const totalCents = totalFromSnapshot(
      log.startAt,
      log.endAt,
      log.ratePer30MinCents,
    );
    entry.programSlots += slots;
    entry.programTotalCents += totalCents;
    // Program pay is a payout (PFA owes the coach) — the OPPOSITE money
    // direction from the cage receivable in `totalCents`. Never net them:
    // it rolls into `programGrandTotalCents`, kept separate end-to-end.
    programGrandTotalCents += totalCents;
  }

  const summary = Array.from(summaryMap.values()).sort((a, b) =>
    a.coachName.localeCompare(b.coachName),
  );

  // Cage-side receivable grand total ONLY — program pay (the opposite
  // direction) is returned separately as programGrandTotalCents.
  const grandTotalCents = detail.reduce((sum, r) => sum + r.totalCents, 0);

  return { detail, summary, grandTotalCents, programGrandTotalCents };
}
