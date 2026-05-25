import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/audit: back link, hero, filters form, audit table.

export default function Loading() {
  return (
    <LoadingShell>
      <Skeleton className="h-3.5 w-14 mb-6" />

      <div className="mb-6 space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Filters card */}
      <Skeleton className="h-32 w-full mb-6" />

      {/* Audit table: header + 10 rows */}
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="bg-surface-2 h-10 border-b border-line" />
        {Array.from({ length: 10 }).map((_, i) => (
          <div
            key={i}
            className="px-4 py-3 border-t border-line grid grid-cols-[140px_120px_100px_1fr] gap-4 items-center"
          >
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-full" />
          </div>
        ))}
      </div>
    </LoadingShell>
  );
}
