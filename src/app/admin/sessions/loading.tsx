import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/sessions: back link, kicker + h1 + sublabel,
// filter chip strip, then the rows table.

export default function Loading() {
  return (
    <LoadingShell>
      <Skeleton className="h-3.5 w-14 mb-6" />

      <div className="mb-8 space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* Filter chip row */}
      <div className="mb-6 flex flex-wrap gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28" />
        ))}
      </div>

      {/* Counter + new-session button row */}
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-9 w-32" />
      </div>

      {/* Sessions table */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
        <div className="bg-surface-2/50 h-10 border-b border-line" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="px-4 py-3 border-t border-line grid grid-cols-6 gap-4"
          >
            {Array.from({ length: 6 }).map((_, j) => (
              <Skeleton key={j} className="h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
    </LoadingShell>
  );
}
