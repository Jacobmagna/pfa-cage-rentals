import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /coach/attendance: h1, then the program/date picker bar and a
// roster checklist column.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="space-y-6">
        <Skeleton className="h-7 w-36" />

        <div className="max-w-2xl space-y-6">
          <Skeleton className="h-24 w-full rounded-lg" />

          <div className="space-y-4 max-w-md">
            <div className="rounded-lg border border-line">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-5 w-5 rounded" />
                  <Skeleton className="h-4 w-40" />
                </div>
              ))}
            </div>
            <Skeleton className="h-11 w-40" />
          </div>
        </div>
      </div>
    </LoadingShell>
  );
}
