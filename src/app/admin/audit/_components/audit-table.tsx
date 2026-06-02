// Audit-log table. Server component. Each row is a <details> so the
// diff is collapsed by default; click to expand and see the
// before/after JSON.
//
// Entity rendering is type-specific: rate_override entityIds are
// composite (`${coachId}:${resourceType}`) and split for display.
// session/block entityIds are UUIDs; truncated for table density.

import type { AuditRow } from "@/lib/audit/fetch";
import { formatPfaDate, formatPfaTime } from "@/lib/timezone";

const ACTION_CLASS: Record<AuditRow["action"], string> = {
  create:
    "bg-success/10 text-success border-success/30",
  update: "bg-gold/10 text-gold-strong border-gold/30",
  delete: "bg-danger/10 text-danger border-danger/30",
};

const ENTITY_LABEL: Record<string, string> = {
  session: "Session",
  block: "Block",
  rate_override: "Rate override",
};

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center">
        <p className="text-sm font-medium text-fg">No entries match</p>
        <p className="mt-1.5 text-sm text-fg-muted max-w-md mx-auto">
          Try widening the date range, unchecking filters, or clearing the
          actor.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
      <table className="w-full min-w-[820px] text-sm">
        <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
          <tr>
            <th scope="col" className="px-4 py-3 text-left font-semibold">When</th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">Actor</th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">Action</th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">Entity</th>
            <th scope="col" className="px-4 py-3 text-left font-semibold">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t border-line hover:bg-surface-2 transition-colors align-top">
              <td className="px-4 py-3 whitespace-nowrap font-mono tnum tabular-nums text-xs text-fg-muted">
                <p>{formatPfaDate(row.ts)}</p>
                <p className="text-fg-subtle text-[10px] mt-0.5">
                  {formatPfaTime(row.ts)}
                </p>
              </td>
              <td className="px-4 py-3 text-sm">
                <p className="text-fg">{row.actorName ?? row.actorEmail}</p>
                {row.actorName ? (
                  <p className="text-[11px] text-fg-subtle mt-0.5">
                    {row.actorEmail}
                  </p>
                ) : null}
              </td>
              <td className="px-4 py-3">
                <span
                  className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${ACTION_CLASS[row.action]}`}
                >
                  {row.action}
                </span>
              </td>
              <td className="px-4 py-3 text-sm">
                <p className="text-fg">
                  {ENTITY_LABEL[row.entityType] ?? row.entityType}
                </p>
                <p className="text-[11px] text-fg-subtle font-mono mt-0.5 break-all">
                  {renderEntityKey(row.entityType, row.entityId)}
                </p>
              </td>
              <td className="px-4 py-3 text-sm max-w-[420px]">
                <details className="group">
                  <summary className="cursor-pointer text-xs text-fg-muted hover:text-fg select-none">
                    <span className="group-open:hidden">Show diff</span>
                    <span className="hidden group-open:inline">Hide diff</span>
                  </summary>
                  <pre className="mt-2 overflow-x-auto rounded-md bg-page border border-line p-3 text-[11px] text-fg-muted leading-relaxed">
                    {formatDiff(row.diff)}
                  </pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Per-entity rendering of the entityId column.
 * - session / block: 8-char UUID prefix (full id revealed in diff JSON).
 * - rate_override: composite `${coachId}:${resourceType}` — show the
 *   resourceType part as the human-readable side, with the coach
 *   truncated. Rate-override audit rows tie to the coach detail page
 *   under H3.
 */
function renderEntityKey(entityType: string, entityId: string): string {
  if (entityType === "rate_override") {
    const [coachId, resourceType] = entityId.split(":");
    return `${resourceType ?? "?"} · coach ${coachId?.slice(0, 8) ?? "?"}…`;
  }
  return `${entityId.slice(0, 8)}…`;
}

function formatDiff(diff: unknown): string {
  if (diff === null || diff === undefined) return "(no diff)";
  try {
    return JSON.stringify(diff, null, 2);
  } catch {
    return String(diff);
  }
}
