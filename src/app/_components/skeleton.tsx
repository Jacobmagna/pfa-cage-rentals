// Skeleton placeholder used by loading.tsx files (J5). Renders a
// rounded block in `bg-surface-2` with a subtle pulse so the user
// sees the page's shape *immediately* while the server-component
// tree resolves.
//
// Why hand-rolled instead of pulling in shadcn's <Skeleton>: keeping
// the dependency surface tight, and the design token surface
// (`bg-surface-2`, `bg-line`) already covers what we need. Tailwind's
// `animate-pulse` is enough motion to read as "loading."
//
// Accessibility: skeletons are decorative — they convey "content is
// coming" via motion. Each loading.tsx wraps them in an element with
// role="status" + a visually hidden label so screen readers announce
// the page is loading once rather than read out a dozen placeholders.

type SkeletonProps = {
  className?: string;
};

export function Skeleton({ className = "" }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={`bg-surface-2 rounded-md animate-pulse ${className}`}
    />
  );
}

// Convenience wrapper for loading.tsx files: provides the screen-
// reader announcement + a polite live region so AT users hear
// "Loading…" once when the route transition starts.
export function LoadingShell({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {children}
    </div>
  );
}
