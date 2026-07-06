import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Route-transition loading state for the /travel group. Reuses the repo's
// hand-rolled Skeleton + LoadingShell (screen-reader "Loading…" announcement
// + polite live region) to match the facility convention. Renders inside
// src/app/travel/layout.tsx, so the shell chrome is already present; this
// just sketches the placeholder hero's shape while the tree resolves.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="flex w-full max-w-xl flex-col items-center gap-3">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-5 w-80 max-w-full" />
        </div>
      </div>
    </LoadingShell>
  );
}
