import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /coach/schedule: header (eyebrow + week heading), the
// prev/next-week control row, then a few day sections with block bars.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="max-w-2xl">
        <div className="mb-6 space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-64" />
        </div>

        <div className="mb-6 flex items-center justify-between gap-2">
          <Skeleton className="h-10 w-9" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-9" />
        </div>

        <div className="space-y-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-14 w-full" />
            </div>
          ))}
        </div>
      </div>
    </LoadingShell>
  );
}
