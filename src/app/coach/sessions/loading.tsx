import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /coach/sessions: back link, kicker, totals h1, sublabel,
// then the session history table.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="max-w-2xl">
        <Skeleton className="h-3.5 w-14 mb-6" />

        <div className="mb-6 space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>

        {/* Session rows: 8 cards */}
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="rounded-md border border-line bg-surface p-4 flex items-center justify-between gap-4"
            >
              <div className="space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </div>
      </div>
    </LoadingShell>
  );
}
