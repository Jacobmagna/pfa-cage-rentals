// Read-only attendance grid (FEAT-10). Presentational — no client
// state needed yet, so it stays a server component. Kept deliberately
// dumb so FEAT-11 can later swap it to a client component and layer a
// per-cell over-cap popover on top without reshaping the data.
//
// Layout mirrors the schedule grid's scroll shell: an
// `overflow-x-auto` container with a border, and a sticky-left first
// column so the athlete-name column stays pinned while the date columns
// scroll horizontally. A vanilla <table> is simpler than CSS grid here
// and gives us real <th scope> semantics for free.
//
// Cells: P (present) in text-success, A (absent) in text-fg-muted,
// blank (no record) renders an em-dash in text-fg-subtle. Tokens only —
// no hardcoded colors.

import {
  formatGridDate,
  type AttendanceGrid as AttendanceGridData,
} from "@/lib/server/attendance-grid";

export function AttendanceGrid({ grid }: { grid: AttendanceGridData }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-fg-subtle">
            <th
              scope="col"
              className="sticky left-0 z-10 bg-surface border-r border-line px-4 py-3 text-left font-medium whitespace-nowrap"
            >
              Athlete
            </th>
            {grid.sessions.map((s) => (
              <th
                scope="col"
                key={s.id}
                className="px-3 py-3 text-center font-medium font-mono tabular-nums whitespace-nowrap"
                title={s.sessionDate}
              >
                {formatGridDate(s.sessionDate)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.athletes.map((a) => {
            const marks = grid.present[a.id];
            return (
              <tr
                key={a.id}
                className="border-b border-line/50 last:border-b-0 hover:bg-surface/60"
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-surface border-r border-line px-4 py-3 text-left font-medium text-fg whitespace-nowrap"
                >
                  {a.lastName}, {a.firstName}
                </th>
                {grid.sessions.map((s) => {
                  const present = marks?.[s.id];
                  return (
                    <td
                      key={s.id}
                      className="px-3 py-3 text-center font-mono tabular-nums"
                    >
                      {present === true ? (
                        <span className="font-semibold text-success">P</span>
                      ) : present === false ? (
                        <span className="font-semibold text-fg-muted">A</span>
                      ) : (
                        <span className="text-fg-subtle" aria-label="No record">
                          —
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
