import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Renders inside src/app/master/layout.tsx (AppShell). Mirrors the hero
// layout of the master schedule pages: sub-nav strip, kicker, date h1,
// sublabel, then the WeekNav + schedule grid block.

export default function Loading() {
  return (
    <LoadingShell>
      {/* Master sub-nav strip */}
      <Skeleton className="h-12 w-full mb-6" />

      <div className="mb-6 space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-32" />
      </div>

      {/* WeekNav strip */}
      <Skeleton className="h-9 w-full mb-6" />

      {/* Schedule grid — header row + 4 resource rows × 14 cells */}
      <div className="overflow-hidden rounded-lg border border-line">
        <div className="bg-surface-2 h-10 border-b border-line" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="grid grid-cols-[120px_repeat(13,minmax(0,1fr))] gap-px bg-line"
          >
            <div className="bg-surface px-3 py-3">
              <Skeleton className="h-4 w-16" />
            </div>
            {Array.from({ length: 13 }).map((_, j) => (
              <div key={j} className="bg-surface h-12" />
            ))}
          </div>
        ))}
      </div>
    </LoadingShell>
  );
}
