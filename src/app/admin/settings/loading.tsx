import { LoadingShell, Skeleton } from "@/app/_components/skeleton";

// Mirrors /admin/settings: back link, kicker + h1 + sublabel,
// then a stack of section cards (org settings + rate defaults).

export default function Loading() {
  return (
    <LoadingShell>
      <Skeleton className="h-3.5 w-14 mb-6" />

      <div className="mb-8 space-y-1.5">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="space-y-6">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </LoadingShell>
  );
}
