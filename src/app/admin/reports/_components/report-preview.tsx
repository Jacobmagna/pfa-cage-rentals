// Server-rendered preview tables for /admin/reports. Two stacked
// tables — Summary (one row per coach) above Detail (one row per
// session). Mirrors the Excel workbook shape so what Dad sees in
// the browser matches the file he downloads (E2).
//
// Server component, no client state. Filter changes happen via the
// form's GET submit; this just re-renders against the new data.

import type { DetailRow, SummaryRow } from "@/lib/reports/aggregate";
import { TeamRentalBadge } from "@/app/_components/team-rental-badge";
import { OnlineBadge } from "@/app/_components/online-badge";

export function ReportPreview({
  detail,
  summary,
  grandTotalCents,
  programGrandTotalCents,
  includeCageSessions,
  includeProgramHours,
}: {
  detail: DetailRow[];
  summary: SummaryRow[];
  grandTotalCents: number;
  programGrandTotalCents: number;
  includeCageSessions: boolean;
  includeProgramHours: boolean;
}) {
  if (detail.length === 0 && summary.length === 0) {
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
            <GrandTotal
              cageCents={grandTotalCents}
              programCents={programGrandTotalCents}
              includeCageSessions={includeCageSessions}
              includeProgramHours={includeProgramHours}
              sessionCount={detail.length}
            />
          }
        />
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left font-semibold">Coach</th>
                {includeCageSessions ? (
                  <>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Cage</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Bullpen</th>
                    <th scope="col" className="px-4 py-3 text-right font-semibold">Weight Room</th>
                  </>
                ) : null}
                {includeProgramHours ? (
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Work hours</th>
                ) : null}
                {includeCageSessions ? (
                  <th scope="col" className="px-4 py-3 text-right font-semibold">Rental owed</th>
                ) : null}
                {includeCageSessions ? (
                  <th scope="col" className="px-4 py-3 text-center font-semibold">Prepaid online</th>
                ) : null}
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
                  {includeCageSessions ? (
                    <>
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
                    </>
                  ) : null}
                  {includeProgramHours ? (
                    <SlotsAndCashCell
                      slots={row.programSlots}
                      cents={row.programTotalCents}
                    />
                  ) : null}
                  {includeCageSessions ? (
                    <td className="px-4 py-3 text-right font-mono tnum tabular-nums font-semibold text-fg">
                      {formatCents(row.totalCents)}
                    </td>
                  ) : null}
                  {includeCageSessions ? (
                    <td className="px-4 py-3 text-center">
                      {row.onlineSessions > 0 ? (
                        <span className="inline-block rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success ring-1 ring-inset ring-success/30 tnum">
                          {row.onlineSessions}
                        </span>
                      ) : (
                        <span className="text-[10px] text-fg-subtle">—</span>
                      )}
                    </td>
                  ) : null}
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
                <th scope="col" className="px-3 py-3 text-left font-semibold">Use</th>
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
                  <td className="px-3 py-3 text-fg">{row.resourceName}</td>
                  <td className="px-3 py-3 text-fg-muted capitalize">
                    {row.useType ?? "—"}
                  </td>
                  <td className="px-3 py-3 text-fg">
                    <span className="inline-flex items-center gap-1.5 flex-wrap">
                      {row.coachName}
                      {row.isTeamRental ? <TeamRentalBadge /> : null}
                      {row.isOnline ? <OnlineBadge /> : null}
                    </span>
                  </td>
                  <NumCell value={row.slots} />
                  <CashCell cents={row.ratePerSlotCents} />
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

// Two clearly-labeled grand totals, NEVER summed: the cage receivable
// (coach owes PFA) and the program payout (PFA owes coach) point in opposite
// money directions. Each shows only when its scope is on.
function GrandTotal({
  cageCents,
  programCents,
  includeCageSessions,
  includeProgramHours,
  sessionCount,
}: {
  cageCents: number;
  programCents: number;
  includeCageSessions: boolean;
  includeProgramHours: boolean;
  sessionCount: number;
}) {
  return (
    <div className="flex items-start justify-end gap-6 text-right">
      {includeCageSessions ? (
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
      ) : null}
      {includeProgramHours ? (
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
            Work pay
          </p>
          <p className="text-xl font-semibold font-mono tnum tabular-nums text-fg">
            {formatCents(programCents)}
          </p>
          <p className="text-[11px] text-fg-subtle">PFA owes coaches</p>
        </div>
      ) : null}
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

function CashCell({ cents }: { cents: number }) {
  return (
    <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-muted">
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
