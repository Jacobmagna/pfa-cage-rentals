"use client";

// Read-only attendance grid (FEAT-10, with the FEAT-11 over-cap layer).
// Converted to a client component so over-cap present cells can render
// red and toggle a small explainer popover. The data shape is unchanged
// — the page still hands in the pure buildAttendanceGrid output plus a
// computeOverCapFlags result (athleteId → sessionId → OverCapInfo).
//
// Layout mirrors the schedule grid's scroll shell: an `overflow-x-auto`
// container with a border, and a sticky-left first column so the
// athlete-name column stays pinned while the date columns scroll
// horizontally. A vanilla <table> gives us real <th scope> semantics.
//
// Cells: P (present) in text-success; an OVER-cap present cell is a red
// <button> (text-danger) that toggles the over-cap popover; A (absent) in
// text-fg-muted; blank (no record) renders an em-dash in text-fg-subtle.
// Tokens only — no hardcoded colors. One popover open at a time.

import { useRef, useState } from "react";
import {
  formatGridDate,
  type AttendanceGrid as AttendanceGridData,
} from "@/lib/server/attendance-grid";
import type { OverCapFlags } from "@/lib/server/attendance-flags";
import { OverCapPopover } from "./over-cap-popover";

export function AttendanceGrid({
  grid,
  flags = {},
}: {
  grid: AttendanceGridData;
  flags?: OverCapFlags;
}) {
  // The single open red cell, keyed "athleteId|sessionId" (one at a time).
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
      <table className="border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
            <th
              scope="col"
              className="sticky left-0 z-10 bg-surface border-r border-line px-4 py-3 text-left font-semibold whitespace-nowrap"
            >
              Athlete
            </th>
            {grid.sessions.map((s) => (
              <th
                scope="col"
                key={s.id}
                className="tnum px-3 py-3 text-center font-semibold font-mono whitespace-nowrap"
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
            const athleteFlags = flags[a.id];
            return (
              <tr
                key={a.id}
                className="group border-t border-line last:border-b-0 transition hover:bg-surface-2"
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-surface border-r border-line px-4 py-3 text-left font-medium text-fg whitespace-nowrap transition group-hover:bg-surface-2"
                >
                  {a.lastName}, {a.firstName}
                </th>
                {grid.sessions.map((s) => {
                  const present = marks?.[s.id];
                  const over = athleteFlags?.[s.id];
                  return (
                    <td
                      key={s.id}
                      className="tnum relative border-l border-line bg-surface-2/40 px-3 py-3 text-center font-mono"
                    >
                      {present === true ? (
                        over ? (
                          <OverCapCell
                            cellKey={`${a.id}|${s.id}`}
                            info={over}
                            open={openKey === `${a.id}|${s.id}`}
                            onToggle={(k) =>
                              setOpenKey((cur) => (cur === k ? null : k))
                            }
                            onClose={() => setOpenKey(null)}
                          />
                        ) : (
                          <span className="font-semibold text-success">P</span>
                        )
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

// A single over-cap present cell: a red P button that toggles its
// popover. Holds the trigger ref so the popover can return focus on close.
function OverCapCell({
  cellKey,
  info,
  open,
  onToggle,
  onClose,
}: {
  cellKey: string;
  info: import("@/lib/server/attendance-flags").OverCapInfo;
  open: boolean;
  onToggle: (key: string) => void;
  onClose: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => onToggle(cellKey)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Over cap — ${info.periodLabel}`}
        className="font-semibold text-danger underline decoration-dotted underline-offset-4 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 rounded"
      >
        P
      </button>
      {open ? (
        <OverCapPopover info={info} onClose={onClose} returnFocusTo={btnRef} />
      ) : null}
    </>
  );
}
