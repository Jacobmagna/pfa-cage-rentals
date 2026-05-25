import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/import: kicker, h1, sublabel, then the upload form
// card. Lightest skeleton of the set — this page's main work is the
// post-upload preview, but the initial load is just the form.

export default function Loading() {
  return (
    <LoadingShell>
      <div className="space-y-2 mb-8">
        <Skeleton className="h-3 w-44" />
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-full max-w-2xl" />
        <Skeleton className="h-4 w-3/4 max-w-xl" />
      </div>
      <Skeleton className="h-64 w-full" />
    </LoadingShell>
  );
}
