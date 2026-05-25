// Server-rendered preview tables for /admin/reports. Two stacked
// tables — Summary (one row per coach) above Detail (one row per
// session). Mirrors the Excel workbook shape so what Dad sees in
// the browser matches the file he downloads (E2).
//
// Server component, no client state. Filter changes happen via the
// form's GET submit; this just re-renders against the new data.

import type { DetailRow, SummaryRow } from "@/lib/reports/aggregate";
import { TeamRentalBadge } from "@/app/_components/team-rental-badge";

export function ReportPreview({
  detail,
  summary,
  grandTotalCents,
}: {
  detail: DetailRow[];
  summary: SummaryRow[];
  grandTotalCents: number;
}) {
  if (detail.length === 0) {
    return (
      <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center">
        <p className="text-sm font-medium text-fg">No sessions match</p>
        <p className="mt-1.5 text-sm text-fg-muted max-w-md mx-auto">
          Try widening the date range or unchecking some filters. Coaches
          with zero sessions in the range are not listed.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader
          eyebrow="Summary"
          title={`${summary.length} ${summary.length === 1 ? "coach" : "coaches"}`}
          rightSlot={
            <GrandTotal cents={grandTotalCents} sessionCount={detail.length} />
          }
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-medium">Coach</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Cage slots</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Cage $</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Bullpen slots</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Bullpen $</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Weight Room slots</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Weight Room $</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Total</th>
                <th scope="col" className="px-4 py-3 text-center font-medium">Rate</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((row) => (
                <tr key={row.coachId} className="border-b border-line/50 last:border-b-0">
                  <td className="px-4 py-3 text-fg">
                    {row.coachName}
                    {row.coachName !== row.coachEmail ? (
                      <span className="block text-[11px] text-fg-subtle">
                        {row.coachEmail}
                      </span>
                    ) : null}
                  </td>
                  <NumCell value={row.cageSlots} />
                  <CashCell cents={row.cageTotalCents} />
                  <NumCell value={row.bullpenSlots} />
                  <CashCell cents={row.bullpenTotalCents} />
                  <NumCell value={row.weightRoomSlots} />
                  <CashCell cents={row.weightRoomTotalCents} />
                  <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-fg">
                    {formatCents(row.totalCents)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {row.appliedOverride ? (
                      <span className="inline-block rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-gold">
                        Override
                      </span>
                    ) : (
                      <span className="text-[10px] text-fg-subtle uppercase tracking-wider">
                        Default
                      </span>
                    )}
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
          title={`${detail.length} ${detail.length === 1 ? "session" : "sessions"}`}
        />
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="bg-surface-2 text-xs uppercase tracking-wider text-fg-muted">
              <tr>
                <th scope="col" className="px-3 py-3 text-left font-medium">Date</th>
                <th scope="col" className="px-3 py-3 text-left font-medium">Day</th>
                <th scope="col" className="px-3 py-3 text-left font-medium">Start</th>
                <th scope="col" className="px-3 py-3 text-left font-medium">End</th>
                <th scope="col" className="px-3 py-3 text-left font-medium">Resource</th>
                <th scope="col" className="px-3 py-3 text-left font-medium">Use</th>
                <th scope="col" className="px-3 py-3 text-left font-medium">Coach</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Slots</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">Rate</th>
                <th scope="col" className="px-3 py-3 text-right font-medium">$</th>
                <th scope="col" className="px-3 py-3 text-left font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {detail.map((row) => (
                <tr key={row.sessionId} className="border-b border-line/50 last:border-b-0">
                  <td className="px-3 py-3 font-mono tabular-nums whitespace-nowrap text-fg-muted">
                    {row.date}
                  </td>
                  <td className="px-3 py-3 text-fg-muted">{row.dayOfWeek}</td>
                  <td className="px-3 py-3 font-mono tabular-nums text-fg">
                    {row.startTime}
                  </td>
                  <td className="px-3 py-3 font-mono tabular-nums text-fg">
                    {row.endTime}
                  </td>
                  <td className="px-3 py-3 text-fg">{row.resourceName}</td>
                  <td className="px-3 py-3 text-fg-muted capitalize">
                    {row.useType ?? "—"}
                  </td>
                  <td className="px-3 py-3 text-fg">
                    <span className="inline-flex items-center gap-1.5 flex-wrap">
                      {row.coachName}
                      {row.isTeamRental ? <TeamRentalBadge /> : null}
                    </span>
                  </td>
                  <NumCell value={row.slots} />
                  <CashCell cents={row.ratePerSlotCents} />
                  <td className="px-3 py-3 text-right font-mono tabular-nums font-semibold text-fg">
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

function GrandTotal({
  cents,
  sessionCount,
}: {
  cents: number;
  sessionCount: number;
}) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
        Grand total
      </p>
      <p className="text-xl font-semibold font-mono tabular-nums text-fg">
        {formatCents(cents)}
      </p>
      <p className="text-[11px] text-fg-subtle">
        across {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
      </p>
    </div>
  );
}

function NumCell({ value }: { value: number }) {
  return (
    <td className="px-4 py-3 text-right font-mono tabular-nums text-fg-muted">
      {value === 0 ? <span className="text-fg-subtle">—</span> : value}
    </td>
  );
}

function CashCell({ cents }: { cents: number }) {
  return (
    <td className="px-4 py-3 text-right font-mono tabular-nums text-fg-muted">
      {cents === 0 ? (
        <span className="text-fg-subtle">—</span>
      ) : (
        formatCents(cents)
      )}
    </td>
  );
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
