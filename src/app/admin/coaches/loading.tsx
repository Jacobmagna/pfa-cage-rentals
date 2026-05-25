import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/coaches: back link, kicker, count h1, sublabel,
// then the coaches table.

export default function Loading() {
  return (
    <LoadingShell>
      <Skeleton className="h-3.5 w-14 mb-6" />

      <div className="mb-6 space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>

      {/* Coaches table: header + 6 rows */}
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="grid grid-cols-[1.5fr_1.5fr_1fr_0.5fr_0.7fr] gap-4 bg-surface-2 px-4 py-3 border-b border-line">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-16" />
          ))}
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[1.5fr_1.5fr_1fr_0.5fr_0.7fr] gap-4 px-4 py-3 border-t border-line"
          >
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-6 ml-auto" />
            <Skeleton className="h-3 w-14 ml-auto" />
          </div>
        ))}
      </div>
    </LoadingShell>
  );
}
