import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Route-transition loading state for /travel/admin/players. Reuses the repo's
// Skeleton + LoadingShell (screen-reader announcement + polite live region) to
// match the facility convention. Sketches the players page shape: header, the
// search bar, and the master table.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-[76px] w-full rounded-md" />
        <Skeleton className="h-80 w-full rounded-md" />
      </div>
    </LoadingShell>
  );
}
