import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/reports: back link, kicker, h1, sublabel + download
// button, filter form, then the report preview.

export default function Loading() {
  return (
    <LoadingShell>
      <Skeleton className="h-3.5 w-14 mb-6" />

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      {/* Filter form card */}
      <Skeleton className="h-48 w-full mb-6" />

      {/* Report preview: summary card + detail table */}
      <Skeleton className="h-32 w-full mb-4" />
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="bg-surface-2 h-10 border-b border-line" />
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="px-4 py-3 border-t border-line grid grid-cols-5 gap-4"
          >
            {Array.from({ length: 5 }).map((_, j) => (
              <Skeleton key={j} className="h-3 w-full" />
            ))}
          </div>
        ))}
      </div>
    </LoadingShell>
  );
}
