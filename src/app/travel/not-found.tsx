import Link from "next/link";

// Travel-scoped 404. Catches `notFound()` calls and unmatched URLs under
// the /travel route group, rendering inside src/app/travel/layout.tsx (so
// html/body/globals + the travel shell are already in place). Server
// component — no client interactivity needed. A 404 isn't an error, so no
// capture. Matches the travel shell's neutral tokens; "Back to home" points
// at the travel root (/), which the proxy serves for the travel host.

export default function TravelNotFound() {
  return (
    <section className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      <div className="w-full max-w-sm">
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
            className="inline-flex h-10 items-center justify-center rounded-md bg-gold px-4 text-sm font-medium text-gold-ink transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            Back to home
          </Link>
        </div>
      </div>
    </section>
  );
}
