// The WORK HOURS tab of /admin/reports (reports-tabs SPEC §3, tab 2).
// Same shape as the cage tab — Summary (one row per coach) above Detail
// (one row per work log) — but the money points the other way:
// PFA OWES THE COACH. The two directions are never summed (§7).
//
// This tab is the fix for SPEC §1(a): work sessions could never appear as
// line items anywhere in Reports, because `detail` is built exclusively
// from sessionsBilling. Every figure here comes from `buildWorkReport`,
// whose summary is a roll-up of the very rows shown below it.
//
// Server component, no client state.

import type { WorkDetailRow, WorkSummaryRow } from "@/lib/reports/work-report";

export function WorkPreview({
  detail,
  summary,
  grandTotalCents,
  grandTotalHours,
}: {
  detail: WorkDetailRow[];
  summary: WorkSummaryRow[];
  grandTotalCents: number;
  grandTotalHours: number;
}) {
  if (detail.length === 0) {
    return (
      <div className="space-y-4">
        <PayoutLedgerCaveat />
        <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center">
          <p className="text-sm font-medium text-fg">No work hours match</p>
          <p className="mt-1.5 text-sm text-fg-muted max-w-md mx-auto">
            Try widening the date range or clearing the coach and program
            filters. Coaches with no logged work in the range are not
            listed.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PayoutLedgerCaveat />

      <section>
        <SectionHeader
          eyebrow="Summary"
          title={`${summary.length} ${summary.length === 1 ? "coach" : "coaches"}`}
          rightSlot={
            <GrandTotal cents={grandTotalCents} hours={grandTotalHours} />
          }
        />
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Coach</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Entries</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Hours</th>
                <th scope="col" className="px-4 py-3 text-right font-semibold">Work pay</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.coachId} className="border-t border-line hover:bg-surface-2 transition-colors">
                  <td className="px-4 py-3 text-fg">
                    {row.coachName}
                    {row.coachName !== row.coachEmail ? (
                      <span className="block text-[11px] text-fg-subtle">
                        {row.coachEmail}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-muted">
                    {row.entries}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg">
                    {formatHours(row.hours)} hr
                  </td>
                  <td className="px-4 py-3 text-right font-mono tnum tabular-nums font-semibold text-fg">
                    {formatCents(row.payCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <SectionHeader
          eyebrow="Detail"
          title={`${detail.length} ${detail.length === 1 ? "entry" : "entries"}`}
        />
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[1040px] text-sm">
            <thead className="bg-surface-2/50 text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line">
              <tr>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Date</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Day</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Start</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">End</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Program</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Coach</th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">Hours</th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">Rate</th>
                <th scope="col" className="px-3 py-3 text-right font-semibold">$</th>
                <th scope="col" className="px-3 py-3 text-left font-semibold">Schedule</th>
              </tr>
            </thead>
            <tbody>
              {detail.map((row) => (
                <tr key={row.id} className="border-t border-line hover:bg-surface-2 transition-colors">
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
                  <td className="px-3 py-3 text-fg">{row.programName}</td>
                  <td className="px-3 py-3 text-fg">{row.coachName}</td>
                  <td className="px-3 py-3 text-right font-mono tnum tabular-nums text-fg-muted">
                    {formatHours(row.hours)}
                  </td>
                  <RateCell
                    ratePer30MinCents={row.ratePer30MinCents}
                    perSessionRateCents={row.perSessionRateCents}
                  />
                  <td className="px-3 py-3 text-right font-mono tnum tabular-nums font-semibold text-fg">
                    {formatCents(row.payCents)}
                  </td>
                  <td className="px-3 py-3 text-fg-subtle text-xs max-w-[220px] truncate">
                    {row.scheduleNote ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

// 🔴 SPEC §7. The app has NO PAYOUT LEDGER — the entire prod DB holds one
// coach_payments row, because Mark pays coaches outside the system. So this
// total is what the logs are WORTH, not what is still outstanding. Without
// this sentence a reader lands on a big number and reads it as "what I
// still owe", which is the single most expensive misreading available on
// this page. Also names where rejected logs went, so their absence from
// these totals is never silent.
function PayoutLedgerCaveat() {
  return (
    <p className="rounded-lg border border-line/60 bg-surface-2/40 px-4 py-3 text-xs text-fg-muted leading-relaxed">
      <span className="font-semibold text-fg">
        This is what the logged work is worth — not what is still owed.
      </span>{" "}
      Payments made outside the app are not deducted here. Posted work only;
      rejected entries are on the{" "}
      <a
        href="/admin/hour-log"
        className="underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded-sm"
      >
        Work Log
      </a>{" "}
      page with their reason.
    </p>
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

// PFA owes the coach — the opposite direction from the cage tab's "Rental
// owed", and never shown alongside it.
function GrandTotal({ cents, hours }: { cents: number; hours: number }) {
  return (
    <div className="flex items-start justify-end gap-6 text-right">
      <div>
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          Work pay
        </p>
        <p className="text-xl font-semibold font-mono tnum tabular-nums text-fg">
          {formatCents(cents)}
        </p>
        <p className="text-[11px] text-fg-subtle">
          {formatHours(hours)} hr · PFA owes coaches
        </p>
      </div>
    </div>
  );
}

// The rate a log was STAMPED at, with an explicit unit so an hourly row and
// a flat-fee row can never be confused for each other. A per-session log
// pays the flat amount regardless of duration, so it says so rather than
// showing an hourly figure that would not reproduce the "$" column.
function RateCell({
  ratePer30MinCents,
  perSessionRateCents,
}: {
  ratePer30MinCents: number | null;
  perSessionRateCents: number | null;
}) {
  if (perSessionRateCents != null) {
    return (
      <td className="px-3 py-3 text-right font-mono tnum tabular-nums text-fg-muted whitespace-nowrap">
        {formatCents(perSessionRateCents)}{" "}
        <span className="text-fg-subtle">/session</span>
      </td>
    );
  }
  if (ratePer30MinCents == null) {
    // No rate was ever stamped — this log pays $0. Say "no rate" rather
    // than "$0.00 /hr", which reads as a deliberate zero rate.
    return (
      <td className="px-3 py-3 text-right text-fg-subtle whitespace-nowrap">
        No rate
      </td>
    );
  }
  // Stored per 30 min; work pay is quoted per HOUR, so ×2 for display.
  return (
    <td className="px-3 py-3 text-right font-mono tnum tabular-nums text-fg-muted whitespace-nowrap">
      {formatCents(ratePer30MinCents * 2)}{" "}
      <span className="text-fg-subtle">/hr</span>
    </td>
  );
}

// 2 decimals, trailing zeros stripped ("2 hr", "1.5 hr", "0.75 hr").
function formatHours(hours: number): string {
  return hours.toFixed(2).replace(/\.?0+$/, "");
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
