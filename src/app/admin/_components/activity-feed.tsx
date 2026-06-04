import type { ActivityKind } from "@/app/admin/_components/activity-feed.logic";

// Presentational "Recent activity" feed for the admin Home page. No client
// hooks — safe to render inside the server component. Each row reads as
// "coach name · action pill · time-ago", newest first. New coach accounts
// arrive as a highlighted "Joined" pill so an unexpected account is easy to
// spot (a small security signal).
export type ActivityFeedItem = {
  id: string;
  coachName: string;
  kind: ActivityKind;
  label: string;
  timeAgo: string;
};

// Pill styling per kind, drawn from the existing token vocabulary so it
// matches the rest of Home. "joined" deliberately stands out.
const PILL_CLASS: Record<ActivityKind, string> = {
  cage: "border-gold/40 bg-gold/10 text-gold-strong",
  program: "border-success/30 bg-success/10 text-success",
  attendance: "border-line bg-fg/5 text-fg",
  joined: "border-gold/60 bg-gold/20 text-gold-strong font-semibold",
  other: "border-line bg-surface text-fg-muted",
};

export function ActivityFeed({ items }: { items: ActivityFeedItem[] }) {
  return (
    <section aria-labelledby="recent-activity-heading" className="mb-10">
      <h2
        id="recent-activity-heading"
        className="mb-4 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted"
      >
        Recent activity
      </h2>

      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-md)]">
        {items.length === 0 ? (
          <p className="px-6 py-5 text-sm text-fg-muted">
            No recent coach activity yet.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-3 px-6 py-3"
              >
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {item.coachName}
                </span>
                <span
                  className={[
                    "shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] tracking-tight",
                    PILL_CLASS[item.kind],
                  ].join(" ")}
                >
                  {item.label}
                </span>
                <span className="shrink-0 text-xs text-fg-muted">
                  {item.timeAgo}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
