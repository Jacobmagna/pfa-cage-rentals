// Small inline badge shown next to a coach's name on any session
// display surface where the session is flagged as a team rental.
// Variants tune density for the surface:
//   - "inline":  default — paired with normal text (sessions table,
//                reports detail, coach history list)
//   - "compact": tiny dot+letter — for cramped grid blocks where
//                a full word doesn't fit (schedule grid)

import { Users } from "lucide-react";

export function TeamRentalBadge({
  variant = "inline",
}: {
  variant?: "inline" | "compact";
}) {
  if (variant === "compact") {
    return (
      <span
        title="Team rental"
        aria-label="Team rental"
        className="inline-flex items-center justify-center h-3.5 w-3.5 rounded-full bg-gold/10 text-gold-strong ring-1 ring-inset ring-gold/40 shrink-0"
      >
        <Users className="h-2 w-2" strokeWidth={3} />
      </span>
    );
  }

  return (
    <span
      aria-label="Team rental"
      className="inline-flex items-center gap-1 rounded-full bg-gold/10 px-2 py-0.5 text-xs font-medium text-gold-strong"
    >
      <Users className="h-2.5 w-2.5" strokeWidth={2.5} />
      Team
    </span>
  );
}
