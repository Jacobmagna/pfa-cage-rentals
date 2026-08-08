// The CAGE RENTALS tab of /admin/reports (reports-tabs SPEC §3, tab 1).
// Two stacked tables — Summary (one row per coach) above Detail (one row
// per session). Money direction: the coach OWES PFA.
//
// Cage-side figures only. Work hours have their own tab and are not
// rendered here; the two directions are never mixed on one screen (§7).
// The `includeCageSessions` / `includeProgramHours` props are gone with
// the scope checkboxes that fed them.
//
// Server component, no client state. Filter changes happen via the
// form's GET submit; this just re-renders against the new data.

import type { ResourceType } from "@/lib/billing";
import {
  hasCageActivity,
  type DetailRow,
  type SummaryRow,
} from "@/lib/reports/aggregate";

export function ReportPreview({
  detail,
  summary,
  grandTotalCents,
}: {
  detail: DetailRow[];
  summary: SummaryRow[];
  grandTotalCents: number;
}) {
  // `summary` spans BOTH money directions — work-only coaches are in
  // there for the Work tab. Listing one here would render an all-dashes
  // row ending in "$0.00 Rental owed", which reads as a debt of zero
  // rather than an absence of rentals. See hasCageActivity.
  const cageSummary = summary.filter(hasCageActivity);

  if (detail.length === 0 && cageSummary.length === 0) {
    return (
      <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center">
        <p className="text-sm font-medium text-fg">No cage rentals match</p>
        <p className="mt-1.5 text-sm text-fg-muted max-w-md mx-auto">
          Try widening the date range or clearing the coach and resource
          filters. Coaches with no rentals in the range are not listed —
          check the Work hours tab for coaching time.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          eyebrow="Summary"
          title={`${cageSummary.length} ${cageSummary.length === 1 ? "coach" : "coaches"}`}
          rightSlot={
            <GrandTotal
              cageCents={grandTotalCents}
              sessionCount={detail.length}
            />
          }
        />
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Coach</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Cage</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Bullpen</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Weight Room</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Group Weight Room</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Rental owed</th>
              </tr>
            </thead>
            <tbody>
              {cageSummary.map((row) => (
                <tr key={row.coachId} className="border-t border-line hover:bg-surface-2 transition-colors">
                  <td className="px-4 py-3 text-fg">
                    {row.coachName}
                    {row.coachName !== row.coachEmail ? (
                      <span className="block text-[11px] text-fg-subtle">
                        {row.coachEmail}
                      </span>
                    ) : null}
                  </td>
                  <SlotsAndCashCell
                    slots={row.cageSlots}
                    cents={row.cageTotalCents}
                  />
                  <SlotsAndCashCell
                    slots={row.bullpenSlots}
                    cents={row.bullpenTotalCents}
                  />
                  <SlotsAndCashCell
                    slots={row.weightRoomSlots}
                    cents={row.weightRoomTotalCents}
                  />
                  <SlotsAndCashCell
                    slots={row.groupWeightRoomSlots}
                    cents={row.groupWeightRoomTotalCents}
                  />
                  <td className="px-4 py-3 text-right font-mono tnum tabular-nums font-semibold text-fg">
                    {formatCents(row.totalCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {detail.length > 0 ? (
      <section>
        <SectionHeader
          eyebrow="Detail"
          title={`${detail.length} ${detail.length === 1 ? "session" : "sessions"}`}
        />
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="bg-surface-2/50 text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line">
              <tr>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Date</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Day</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Start</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">End</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Resource</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Coach</th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">Slots</th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">Rate</th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">$</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Note</th>
              </tr>
            </thead>
            <tbody>
              {detail.map((row) => (
                <tr key={row.sessionId} className="border-t border-line hover:bg-surface-2 transition-colors">
                  <td className="px-3 py-3 font-mono tnum tabular-nums whitespace-nowrap text-fg-muted">
                    {row.date}
                  </td>
                  <td className="px-3 py-3 text-fg-muted">{row.dayOfWeek}</td>
                  <td className="px-3 py-3 font-mono tnum tabular-nums text-fg">
                    {row.startTime}
                  </td>
                  <td className="px-3 py-3 font-mono tnum tabular-nums text-fg">
                    {row.endTime}
                  </td>
                  <td className="px-3 py-3 text-fg">
                    {row.resourceType === "weight_room" && row.isGroupSession
                      ? `${row.resourceName} (Group)`
                      : row.resourceName}
                  </td>
                  <td className="px-3 py-3 text-fg">
                    <span className="inline-flex items-center gap-1.5 flex-wrap">
                      {row.coachName}
                    </span>
                  </td>
                  <NumCell value={row.slots} />
                  <RateCell
                    cents={row.ratePerSlotCents}
                    resourceType={row.resourceType}
                  />
                  <td className="px-3 py-3 text-right font-mono tnum tabular-nums font-semibold text-fg">
                    {formatCents(row.totalCents)}
                  </td>
                  <td className="px-3 py-3 text-fg-subtle text-xs max-w-[260px] truncate">
                    {row.note ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      ) : null}
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  rightSlot,
}: {
  eyebrow: string;
  title: string;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          {eyebrow}
        </p>
        <p className="text-sm font-medium text-fg-muted">{title}</p>
      </div>
      {rightSlot}
    </div>
  );
}

// The cage receivable — money the coach OWES PFA. The work payout points
// the OPPOSITE way and lives on its own tab; the two are never summed and
// never share a total (SPEC §7).
function GrandTotal({
  cageCents,
  sessionCount,
}: {
  cageCents: number;
  sessionCount: number;
}) {
  return (
    <div className="flex items-start justify-end gap-6 text-right">
      <div>
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          Rental owed
        </p>
        <p className="text-xl font-semibold font-mono tnum tabular-nums text-fg">
          {formatCents(cageCents)}
        </p>
        <p className="text-[11px] text-fg-subtle">
          across {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
        </p>
      </div>
    </div>
  );
}

function NumCell({ value }: { value: number }) {
  return (
    <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-muted">
      {value === 0 ? <span className="text-fg-subtle">—</span> : value}
    </td>
  );
}

function SlotsAndCashCell({
  slots,
  cents,
}: {
  slots: number;
  cents: number;
}) {
  if (slots === 0 && cents === 0) {
    return (
      <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-subtle">
        —
      </td>
    );
  }
  return (
    <td className="px-4 py-3 text-right font-mono tnum tabular-nums leading-tight">
      <span className="block text-fg">
        {slots} {slots === 1 ? "slot" : "slots"}
      </span>
      <span className="block text-[11px] text-fg-subtle">
        {formatCents(cents)}
      </span>
    </td>
  );
}

// Per-row rate cell with an EXPLICIT unit suffix, so the mixed-resource
// column is never ambiguous. The stored snapshot is per-30-min cents; we
// display weight-room rates per HOUR (×2) and cage/bullpen per 30 min.
// Display-only — the snapshot and all totals/sums are untouched.
function RateCell({
  cents,
  resourceType,
}: {
  cents: number;
  resourceType: ResourceType;
}) {
  if (cents === 0) {
    return (
      <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-muted">
        <span className="text-fg-subtle">—</span>
      </td>
    );
  }
  const perHour = resourceType === "weight_room";
  const displayCents = perHour ? cents * 2 : cents;
  const unit = perHour ? "/hr" : "/30 min";
  return (
    <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-muted whitespace-nowrap">
      {formatCents(displayCents)}{" "}
      <span className="text-fg-subtle">{unit}</span>
    </td>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
