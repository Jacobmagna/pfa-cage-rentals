"use client";

// Last-resort error boundary. Fires only when the root layout itself
// throws — by that point Next.js has bypassed the root layout entirely,
// so we have to declare our own <html>/<body> and import globals.css
// directly to keep the dark/gold tokens available.

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";
import "./globals.css";

export default function GlobalError({
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
    <html lang="en">
      <body className="min-h-screen bg-page text-fg antialiased flex flex-col items-center justify-center px-6 py-16">
        <div className="w-full max-w-sm text-center">
          <div className="mb-8 flex items-center justify-center gap-2.5">
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              className="h-2.5 w-2.5 text-gold-strong"
            >
              <path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z" />
            </svg>
            <span className="text-base font-bold tracking-tight text-fg">
              PFA Cage Rentals
            </span>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-fg">
            Something broke
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-fg-muted">
            Something broke on our end. We&rsquo;ve logged it and will take
            a look. You can try again, or head back home.
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
      </body>
    </html>
  );
}
