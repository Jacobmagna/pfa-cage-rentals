import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Week-strip date navigator. Shows Mon–Sun of the week containing
// the currently-selected date, with prev/next chevrons flanking.
// Pure server component — each day is a <Link>, so clicking just
// changes the URL ?date= and the page re-renders against the new
// day. No client JS needed.

export function WeekNav({ selectedDate }: { selectedDate: Date }) {
  const monday = startOfWeek(selectedDate);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
  const prevWeek = new Date(monday);
  prevWeek.setDate(monday.getDate() - 7);
  const nextWeek = new Date(monday);
  nextWeek.setDate(monday.getDate() + 7);

  const today = startOfDay(new Date());
  const selectedKey = formatDateInput(selectedDate);

  return (
    <div className="mb-5 flex items-center gap-2">
      <NavChevron href={`?date=${formatDateInput(prevWeek)}`} dir="left" />

      <div className="flex flex-1 gap-1">
        {days.map((d) => {
          const key = formatDateInput(d);
          const isSelected = key === selectedKey;
          const isToday = startOfDay(d).getTime() === today.getTime();
          return (
            <Link
              key={key}
              href={`?date=${key}`}
              className={[
                "flex-1 text-center rounded-md border px-2 py-2 transition-colors",
                isSelected
                  ? "border-gold bg-gold/10 text-gold"
                  : "border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg",
              ].join(" ")}
            >
              <p className="text-[10px] uppercase tracking-[0.14em]">
                {d.toLocaleDateString("en-US", { weekday: "short" })}
              </p>
              <p className="mt-0.5 text-sm font-semibold tabular-nums">
                {d.getDate()}
                {isToday ? (
                  <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-gold align-middle" />
                ) : null}
              </p>
            </Link>
          );
        })}
      </div>

      <NavChevron href={`?date=${formatDateInput(nextWeek)}`} dir="right" />
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
      className="inline-flex h-12 w-9 items-center justify-center rounded-md border border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg transition-colors"
      aria-label={dir === "left" ? "Previous week" : "Next week"}
    >
      <Icon className="h-4 w-4" />
    </Link>
  );
}

function startOfWeek(d: Date): Date {
  const copy = startOfDay(d);
  const dayOfWeek = copy.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  // Treat Monday as week start (ISO).
  const offset = (dayOfWeek + 6) % 7;
  copy.setDate(copy.getDate() - offset);
  return copy;
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
