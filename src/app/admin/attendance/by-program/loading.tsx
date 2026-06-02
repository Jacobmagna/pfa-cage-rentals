import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// The attendance section layout (FEAT-07) already renders the kicker +
// h1 + sub-nav, so this child loading state only covers the picker +
// grid shell that stream in below it.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="space-y-6">
        {/* Program picker */}
        <div className="rounded-lg border border-line bg-surface p-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-10 w-20" />
          </div>
        </div>

        {/* Grid shell */}
        <div className="overflow-hidden rounded-lg border border-line">
          <div className="bg-surface-2 h-11 border-b border-line" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="grid grid-cols-6 gap-4 border-t border-line px-4 py-3"
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
