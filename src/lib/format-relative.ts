import { formatPfaDateLong } from "@/lib/timezone";

// Shared "time ago" formatter for compact activity surfaces. Mirrors the
// proven local copy in src/app/admin/records/page.tsx (and the older
// cage-rentals copy): bucket recent timestamps into "just now" / "Nm ago"
// / "Nh ago" / "Nd ago", and fall back to a short absolute date for
// anything a week or more in the past.
//
// Pure: takes `now` explicitly so callers (and tests) control the clock.
export function formatRelative(then: Date, now: Date): string {
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return formatPfaDateLong(then);
}
