// Pure aggregation for billing reports. No DB, no React, no I/O.
// Both the live admin preview (Stage E1) and the ExcelJS export
// (Stage E2) call this — single source of truth for what a "report
// row" looks like, plus drives unit tests in E3.
//
// Cents discipline: every monetary number stays in integer cents.
// Dollar formatting happens at the boundary (the page renders
// "$X.XX", the Excel workbook applies a currency format).
//
// Rate selection: each detail row records whether the rate came
// from the default constants (billing.ts) or a coach override
// (`rateSource`). The Summary row's `appliedOverride` flag rolls
// that up so Dad can spot "this coach is on an override rate"
// without scanning the detail.

import {
  chargeForSession,
  type RateOverride,
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
  useType: "hitting" | "pitching" | null;
  note: string | null;
  isTeamRental: boolean;
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
  rateSource: "default" | "override";
  totalCents: number;
  note: string | null;
  isTeamRental: boolean;
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
  appliedOverride: boolean;
};

export type ReportData = {
  detail: DetailRow[];
  summary: SummaryRow[];
  grandTotalCents: number;
};

/**
 * Turns raw session inputs + rate overrides into the canonical report
 * shape. Detail is in the input order (caller should pre-sort by
 * date); Summary is sorted by coach name for stable UI / Excel output.
 */
export function aggregateReport(
  sessions: AggregateSessionInput[],
  overrides: RateOverride[],
): ReportData {
  const detail: DetailRow[] = sessions.map((s) => {
    const charge = chargeForSession(
      {
        coachId: s.coachId,
        resourceType: s.resourceType,
        startAt: s.startAt,
        endAt: s.endAt,
      },
      overrides,
    );
    const hadOverride = overrides.some(
      (o) => o.coachId === s.coachId && o.resourceType === s.resourceType,
    );
    return {
      sessionId: s.sessionId,
      date: formatPfaDate(s.startAt),
      dayOfWeek: formatPfaWeekday(s.startAt),
      startTime: formatPfaTime(s.startAt),
      endTime: formatPfaTime(s.endAt),
      durationMinutes: Math.round(
        (s.endAt.getTime() - s.startAt.getTime()) / 60_000,
      ),
      slots: charge.slots,
      resourceName: s.resourceName,
      resourceType: s.resourceType,
      coachId: s.coachId,
      coachName: s.coachName ?? s.coachEmail,
      coachEmail: s.coachEmail,
      useType: s.useType,
      ratePerSlotCents: charge.ratePer30MinCents,
      rateSource: hadOverride ? "override" : "default",
      totalCents: charge.totalCents,
      note: s.note,
      isTeamRental: s.isTeamRental,
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
        appliedOverride: false,
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
    if (row.rateSource === "override") entry.appliedOverride = true;
  }

  const summary = Array.from(summaryMap.values()).sort((a, b) =>
    a.coachName.localeCompare(b.coachName),
  );

  const grandTotalCents = detail.reduce((sum, r) => sum + r.totalCents, 0);

  return { detail, summary, grandTotalCents };
}
