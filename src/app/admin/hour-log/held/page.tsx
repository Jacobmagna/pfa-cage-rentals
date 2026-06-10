import Link from "next/link";
import { ArrowLeft, Inbox } from "lucide-react";
import { requireRole } from "@/lib/authz";
import { loadHeldHourLogs } from "@/lib/server/hour-log-actions";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";
import { HeldRowActions } from "./held-row-actions";

// /admin/hour-log/held — 1b security B. The admin approval queue for HELD
// manual work-logs. When a coach manually logs hours that don't cleanly match
// a scheduled block (unscheduled / wrong-time / over-logged), they can send
// the log here for approval. A held log is NOT payable and isn't counted
// anywhere until an admin approves it (which flips it to posted); rejecting
// deletes it (the coach re-enters). Thin server shell — guards the role, loads
// the held rows, renders; row actions live in a small client island. Mirrors
// the cage-rental removal-requests queue chrome.

const ISSUE_LABEL: Record<string, string> = {
  unscheduled: "Not on schedule",
  wrong_time: "Wrong time",
  over_logged: "Over-logged",
};

export default async function HeldHourLogsPage() {
  await requireRole("admin");

  const rows = await loadHeldHourLogs();

  return (
    <>
      <Link
        href="/admin/hour-log"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Work Log
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Held work logs
        </h1>
        <p className="text-sm text-fg-muted">
          These are manual logs a coach flagged for approval because they
          didn&apos;t match a scheduled block. Approving makes the log payable
          and counts it everywhere; rejecting removes it.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <Inbox
            className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">No held work logs</p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Nothing to review right now.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[920px] text-sm">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th className="px-4 py-3 text-left">Coach</th>
                <th className="px-4 py-3 text-left">Work</th>
                <th className="px-4 py-3 text-left">When</th>
                <th className="px-4 py-3 text-left">Issue</th>
                <th className="px-4 py-3 text-left">Note</th>
                <th className="px-4 py-3 text-left">Logged</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const coachLabel = r.coachName ?? "Unknown coach";
                const whenLabel = `${formatPfaDateMedium(r.startAt)} · ${formatPfaTime12h(r.startAt)}`;
                const issueLabel = r.heldReason
                  ? (ISSUE_LABEL[r.heldReason] ?? r.heldReason)
                  : "—";
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-medium text-fg">
                      {coachLabel}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {r.programName}
                    </td>
                    <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                      {formatPfaDateMedium(r.startAt)}
                      <span className="text-fg-subtle">
                        {" · "}
                        {formatPfaTime12h(r.startAt)} –{" "}
                        {formatPfaTime12h(r.endAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-muted whitespace-nowrap">
                        {issueLabel}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {r.note ? (
                        <span
                          className="block max-w-[22ch] truncate"
                          title={r.note}
                        >
                          {r.note}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                      {formatPfaDateMedium(r.createdAt)}
                      <span className="text-fg-subtle">
                        {" · "}
                        {formatPfaTime12h(r.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <HeldRowActions
                        id={r.id}
                        coachLabel={coachLabel}
                        whenLabel={whenLabel}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
