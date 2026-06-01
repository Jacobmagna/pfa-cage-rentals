import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/programs: back link, kicker + h1 + sublabel, the
// add-program card, then the programs table.
export default function Loading() {
  return (
    <LoadingShell>
      <Skeleton className="h-3.5 w-14 mb-6" />

      <div className="mb-6 space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* Add-program card */}
      <Skeleton className="h-44 w-full mb-6" />

      {/* Programs table */}
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="bg-surface-2 h-10 border-b border-line" />
        {Array.from({ length: 6 }).map((_, i) => (
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
