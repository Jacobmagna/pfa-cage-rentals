import { Skeleton } from "@/app/_components/skeleton";

// Streams inside the attendance section layout (h1 + sub-nav already
// rendered). Roughly mirrors the roster page: add-athlete card, then
// the athlete table.
export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
