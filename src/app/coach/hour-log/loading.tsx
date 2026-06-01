import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /coach/hour-log: h1, kicker/sublabel, then the hour-log
// form (program / date / start+end / note fields + submit button)
// inside a max-w-md column.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="space-y-6">
        <Skeleton className="h-7 w-32" />

        <div className="max-w-md">
          <div className="space-y-1.5 mb-7">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-48" />
          </div>

          <div className="space-y-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-10 w-full" />
              </div>
            ))}
            <Skeleton className="h-11 w-full mt-6" />
          </div>
        </div>
      </div>
    </LoadingShell>
  );
}
