import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatPfaDate, formatPfaWeekday, pfaDayStart, pfaParts } from "@/lib/timezone";

// Week-strip date navigator. Shows Mon–Sun of the week containing
// the currently-selected date, with prev/next chevrons flanking.
// Pure server component — each day is a <Link>, so clicking just
// changes the URL ?date= and the page re-renders against the new
// day. No client JS needed.

const DAY_MS = 24 * 60 * 60 * 1000;

export function WeekNav({ selectedDate }: { selectedDate: Date }) {
  const monday = pfaWeekStart(selectedDate);
  const days = Array.from({ length: 7 }, (_, i) =>
    // Add 0.5 day per step then snap to PFA midnight — handles DST
    // boundary (23h spring-forward / 25h fall-back) cleanly because
    // pfaDayStart maps any instant inside a PFA day to that day's midnight.
    pfaDayStart(new Date(monday.getTime() + (i + 0.5) * DAY_MS)),
  );
  days[0] = monday; // exact, no rounding error on day 0

  const prevWeek = pfaDayStart(new Date(monday.getTime() - 6.5 * DAY_MS));
  const nextWeek = pfaDayStart(new Date(monday.getTime() + 7.5 * DAY_MS));

  const todayKey = formatPfaDate(new Date());
  const selectedKey = formatPfaDate(selectedDate);

  return (
    <div className="mb-5 flex items-center gap-2">
      <NavChevron href={`?date=${formatPfaDate(prevWeek)}`} dir="left" />

      <div className="flex flex-1 gap-1">
        {days.map((d) => {
          const key = formatPfaDate(d);
          const isSelected = key === selectedKey;
          const isToday = key === todayKey;
          return (
            <Link
              key={key}
              href={`?date=${key}`}
              className={[
                "flex-1 text-center rounded-md border px-2 py-2 shadow-[var(--shadow-sm)] transition",
                isSelected
                  ? "border-gold bg-gold/10 text-gold-strong"
                  : "border-line bg-surface text-fg-muted hover:-translate-y-px hover:border-gold/40 hover:text-fg hover:shadow-[var(--shadow-md)]",
              ].join(" ")}
            >
              <p className="text-[10px] uppercase tracking-[0.14em]">
                {formatPfaWeekday(d)}
              </p>
              <p className="tnum mt-0.5 text-sm font-semibold">
                {pfaParts(d).day}
                {isToday ? (
                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-gold align-middle" />
                ) : null}
              </p>
            </Link>
          );
        })}
      </div>

      <NavChevron href={`?date=${formatPfaDate(nextWeek)}`} dir="right" />
    </div>
  );
}

function NavChevron({
  href,
  dir,
}: {
  href: string;
  dir: "left" | "right";
}) {
  const Icon = dir === "left" ? ChevronLeft : ChevronRight;
  return (
    <Link
      href={href}
      className="inline-flex h-12 w-9 items-center justify-center rounded-md border border-line-strong bg-surface text-fg-muted shadow-[var(--shadow-sm)] transition hover:-translate-y-px hover:text-fg hover:shadow-[var(--shadow-md)]"
      aria-label={dir === "left" ? "Previous week" : "Next week"}
    >
      <Icon className="h-4 w-4" />
    </Link>
  );
}

// Returns PFA midnight of the Monday in the PFA week containing d.
// ISO week = Monday-start.
function pfaWeekStart(d: Date): Date {
  const dayMidnight = pfaDayStart(d);
  // PFA midnight rendered as a UTC instant — getUTCDay reads the same
  // calendar day as the PFA wall clock (since both agree on midnight).
  const dayOfWeek = dayMidnight.getUTCDay(); // 0=Sun..6=Sat
  const offsetDays = (dayOfWeek + 6) % 7; // days back to Monday
  return pfaDayStart(new Date(dayMidnight.getTime() - (offsetDays - 0.5) * DAY_MS));
}
