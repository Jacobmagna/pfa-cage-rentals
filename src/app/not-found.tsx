import Link from "next/link";
import { DiamondMark } from "./_components/diamond-mark";

// Global 404. Catches both `notFound()` calls from server components and
// unmatched URLs. Server component (no client interactivity needed) —
// renders inside the root layout, so html/body/globals are already in
// place. No Sentry capture: a 404 isn't an error.

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <DiamondMark className="h-2.5 w-2.5 text-gold/70" filled />
          <span className="text-base font-bold tracking-tight text-gold">
            PFA Cage Rentals
          </span>
        </div>

        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          404
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg">
          Page not found
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          We couldn&rsquo;t find that page. It might have moved, or the link
          is mistyped.
        </p>

        <div className="mt-8">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-10 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
