import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/hour-log: back link, kicker + h1 + sublabel, filter
// row, download button row, then the rows table.

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
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-28" />
        ))}
      </div>

      {/* Download button row */}
      <div className="mb-4 flex items-center justify-end">
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Hours table */}
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="bg-surface-2 h-10 border-b border-line" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="px-4 py-3 border-t border-line grid grid-cols-7 gap-4"
          >
            {Array.from({ length: 7 }).map((_, j) => (
              <Skeleton key={j} className="h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
    </LoadingShell>
  );
}
