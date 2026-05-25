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

import { slotsBetween, type ResourceType } from "@/lib/billing";
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
  useType: "hitting" | "pitching" | null;
  note: string | null;
  isTeamRental: boolean;
  pfaReferred: boolean;
  isOnline: boolean;
  /** Cents-per-30-min rate stamped on the session row at creation. */
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
  useType: "hitting" | "pitching" | null;
  ratePerSlotCents: number;
  totalCents: number;
  note: string | null;
  isTeamRental: boolean;
  pfaReferred: boolean;
  isOnline: boolean;
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
  totalCents: number;
  onlineSessions: number;
};

export type ReportData = {
  detail: DetailRow[];
  summary: SummaryRow[];
  grandTotalCents: number;
};

/**
 * Turns raw session inputs into the canonical report shape. Detail
 * is in the input order (caller should pre-sort by date); Summary
 * is sorted by coach name for stable UI / Excel output.
 *
 * Reads `ratePer30MinCents` straight off each input row — never
 * recomputes. Online sessions arrive with rate 0 and naturally
 * contribute $0 to totals.
 */
export function aggregateReport(
  sessions: AggregateSessionInput[],
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
      useType: s.useType,
      ratePerSlotCents: s.ratePer30MinCents,
      totalCents,
      note: s.note,
      isTeamRental: s.isTeamRental,
      pfaReferred: s.pfaReferred,
      isOnline: s.isOnline,
    };
  });

  // Roll detail rows up per coach. Map keyed by coachId for O(1)
  // upsert; converted to array + sorted at the end.
  const summaryMap = new Map<string, SummaryRow>();
  for (const row of detail) {
    let entry = summaryMap.get(row.coachId);
    if (!entry) {
      entry = {
        coachId: row.coachId,
        coachName: row.coachName,
        coachEmail: row.coachEmail,
        cageSlots: 0,
        cageTotalCents: 0,
        bullpenSlots: 0,
        bullpenTotalCents: 0,
        weightRoomSlots: 0,
        weightRoomTotalCents: 0,
        totalCents: 0,
        onlineSessions: 0,
      };
      summaryMap.set(row.coachId, entry);
    }
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
    if (row.isOnline) entry.onlineSessions += 1;
  }

  const summary = Array.from(summaryMap.values()).sort((a, b) =>
    a.coachName.localeCompare(b.coachName),
  );

  const grandTotalCents = detail.reduce((sum, r) => sum + r.totalCents, 0);

  return { detail, summary, grandTotalCents };
}
