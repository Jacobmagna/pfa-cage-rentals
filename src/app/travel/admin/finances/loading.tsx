import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Route-transition loading state for /travel/admin/finances. Reuses the repo's
// Skeleton + LoadingShell (screen-reader announcement + polite live region) to
// match the facility convention. Sketches the finances page shape: header, the
// period bar, the summary-card grid, and a breakdown table.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-[76px] w-full rounded-md" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full rounded-md" />
          ))}
        </div>
        <Skeleton className="h-64 w-full rounded-md" />
      </div>
    </LoadingShell>
  );
}
