"use client";

// Catches errors anywhere under the root layout that don't have a more
// specific error.tsx. /admin and /coach have their own variants so the
// AppShell stays visible; this one fires for the public surfaces
// (landing, /privacy, /terms) where there's no signed-in chrome to keep.
//
// Rendered INSIDE the root layout (html/body + globals.css are already
// in place), so this just centers a card on bg-page.

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import { DiamondMark } from "./_components/diamond-mark";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm text-center">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <DiamondMark className="h-2.5 w-2.5 text-gold/70" filled />
          <span className="text-base font-bold tracking-tight text-gold">
            PFA Cage Rentals
          </span>
        </div>

        <h1 className="text-2xl font-bold tracking-tight text-fg">
          Something broke
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Something broke on our end. We&rsquo;ve logged it and will take a
          look. You can try again, or head back home.
        </p>

        <div className="mt-8 flex flex-col items-stretch gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-10 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center justify-center text-fg-muted hover:text-fg h-9 px-3 text-sm font-medium transition-colors"
          >
            Back to home
          </Link>
        </div>
      </div>
    </main>
  );
}
