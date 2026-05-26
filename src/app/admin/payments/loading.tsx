import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/payments: back link, kicker + h1 + sublabel,
// balances table, awaiting-confirmation inbox, recent table.

export default function Loading() {
  return (
    <LoadingShell>
      <Skeleton className="h-3.5 w-14 mb-6" />

      <div className="mb-8 space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* Counter + record-payment button row */}
      <div className="mb-4 flex items-center justify-between">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Balances section */}
      <div className="mb-10">
        <Skeleton className="h-3 w-20 mb-3" />
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="bg-surface-2 h-10 border-b border-line" />
          {Array.from({ length: 5 }).map((_, i) => (
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
      </div>

      {/* Awaiting confirmation */}
      <div className="mb-10">
        <Skeleton className="h-3 w-44 mb-3" />
        <Skeleton className="h-16 w-full" />
      </div>

      {/* Recent payments */}
      <div>
        <Skeleton className="h-3 w-32 mb-3" />
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="bg-surface-2 h-10 border-b border-line" />
          {Array.from({ length: 6 }).map((_, i) => (
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
      </div>
    </LoadingShell>
  );
}
