import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /coach/sessions/new: max-w-md column, back link,
// kicker/h1/sublabel, then the log-session form (~5 labeled
// fields + submit button).

export default function Loading() {
  return (
    <LoadingShell>
      <div className="max-w-md">
        <Skeleton className="h-3.5 w-14 mb-6" />

        <div className="space-y-1.5 mb-7">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>

        <div className="space-y-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
          <Skeleton className="h-11 w-full mt-6" />
        </div>
      </div>
    </LoadingShell>
  );
}
