import { Users } from "lucide-react";

// Shared "Group" indicator for weight-room rentals billed at the group rate
// (sessions_billing.is_group_session). Two variants keep the treatment
// consistent everywhere it appears:
//
//   <GroupPill />  — the full chip. Copies the established "Recurring" chip
//     (block-edit-dialog.tsx): rounded-full border, uppercase micro-label,
//     lucide Users icon. Use on record/list rows + read-only edit dialogs.
//
//   <GroupMark />  — a compact icon-only marker for the tight 30-min schedule
//     grid BARS where a full pill won't fit. Same Users icon, same muted
//     color, but no label/border so it reads at bar scale.
//
// Both are pure/presentational. Render either ONLY when is_group_session.

export function GroupPill(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-muted">
      <Users className="h-3 w-3" />
      Group
    </span>
  );
}

// Compact indicator for schedule-grid bars — icon only. `title` on the parent
// bar already carries context, so this is aria-hidden.
export function GroupMark(): React.JSX.Element {
  return (
    <Users
      className="h-3 w-3 shrink-0 text-fg-muted"
      aria-hidden
    />
  );
}
