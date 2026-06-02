// Small inline badge shown next to a coach's name on session
// display surfaces when the session is flagged as PFA-referred —
// the client was arranged by PFA rather than sourced by the coach.
// Mirrors TeamRentalBadge's variants so the schedule grid can use
// the compact form in cramped cells.

import { Sparkles } from "lucide-react";

export function PfaReferredBadge({
  variant = "inline",
}: {
  variant?: "inline" | "compact";
}) {
  if (variant === "compact") {
    return (
      <span
        title="PFA-referred"
        aria-label="PFA-referred"
        className="inline-flex items-center justify-center h-3.5 w-3.5 rounded-full bg-gold/10 text-gold-strong ring-1 ring-inset ring-gold/40 shrink-0"
      >
        <Sparkles className="h-2 w-2" strokeWidth={3} />
      </span>
    );
  }

  return (
    <span
      aria-label="PFA-referred"
      className="inline-flex items-center gap-1 rounded-full bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold-strong"
    >
      <Sparkles className="h-2.5 w-2.5" strokeWidth={2.5} />
      PFA
    </span>
  );
}
