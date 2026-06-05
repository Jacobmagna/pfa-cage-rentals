// Small inline badge shown next to a coach's name on session display
// surfaces when the session is flagged as a prepaid online lesson —
// PFA collected from the client directly, so the snapshotted rate is
// $0 and the coach owes nothing for the slot.
//
// Same variant API as TeamRentalBadge / PfaReferredBadge so callers
// can swap variants on cramped surfaces (schedule grid uses compact).

import { Wifi } from "lucide-react";

export function OnlineBadge({
  variant = "inline",
}: {
  variant?: "inline" | "compact";
}) {
  if (variant === "compact") {
    return (
      <span
        title="Prepaid online lesson"
        aria-label="Prepaid online lesson"
        className="inline-flex items-center justify-center h-3.5 w-3.5 rounded-full bg-success/10 text-success ring-1 ring-inset ring-success/30 shrink-0"
      >
        <Wifi className="h-2 w-2" strokeWidth={3} />
      </span>
    );
  }

  return (
    <span
      aria-label="Prepaid online lesson"
      className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success"
    >
      <Wifi className="h-2.5 w-2.5" strokeWidth={2.5} />
      Prepaid online
    </span>
  );
}
