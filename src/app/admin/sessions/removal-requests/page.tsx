import { Inbox } from "lucide-react";
import { requireRole } from "@/lib/authz";
import { RentalsSubnav } from "@/app/admin/_components/rentals-subnav";
import { loadPendingRemovalRequests } from "@/lib/server/session-removal-actions";
import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";
import { RemovalRequestRowActions } from "./removal-request-row-actions";

// /admin/sessions/removal-requests — 1b security. A cage rental is money the
// coach owes PFA, so a coach can't erase a PAST charge unilaterally. Instead
// they file a "didn't happen — request removal" that an admin approves (which
// hard-deletes the rental, recording the #26/27 cancellation as admin) or
// denies. This queue is the admin's review surface. Thin server shell — guards
// the role, loads the pending requests, renders; row actions live in a small
// client island. Mirrors the cancellations sub-page chrome.

export default async function RemovalRequestsPage() {
  await requireRole("admin");

  const requests = await loadPendingRemovalRequests();

  return (
    <div className="space-y-6">
      <RentalsSubnav />

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Rentals
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Removal requests
        </h1>
        <p className="text-sm text-fg-muted">
          Coaches can&apos;t delete a rental that has already started — they ask
          you to remove it. Approving deletes the rental for good; denying keeps
          it on the books.
        </p>
      </div>

      {requests.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <Inbox
            className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">
            No pending removal requests
          </p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Nothing to review right now.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
              <tr>
                <th className="px-4 py-3 text-left">Coach</th>
                <th className="px-4 py-3 text-left">Resource</th>
                <th className="px-4 py-3 text-left">Rental when</th>
                <th className="px-4 py-3 text-left">Reason</th>
                <th className="px-4 py-3 text-left">Requested</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {requests.map((r) => {
                const coachLabel = r.coachName ?? "Unknown coach";
                const whenLabel = `${formatPfaDateMedium(r.startAt)} · ${formatPfaTime12h(r.startAt)}`;
                return (
                  <tr key={r.id}>
                    <td className="px-4 py-3 font-medium text-fg">
                      {coachLabel}
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {r.resourceName ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                      {formatPfaDateMedium(r.startAt)}
                      <span className="text-fg-subtle">
                        {" · "}
                        {formatPfaTime12h(r.startAt)} – {formatPfaTime12h(r.endAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-fg-muted">
                      {r.reason ? (
                        <span className="block max-w-[22ch] truncate" title={r.reason}>
                          {r.reason}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-fg-muted whitespace-nowrap">
                      {formatPfaDateMedium(r.requestedAt)}
                      <span className="text-fg-subtle">
                        {" · "}
                        {formatPfaTime12h(r.requestedAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <RemovalRequestRowActions
                        requestId={r.id}
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
    </div>
  );
}
