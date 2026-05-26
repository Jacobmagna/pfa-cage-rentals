"use client";

// Catches errors inside /coach/*. Renders inside the coach AppShell —
// see src/app/admin/error.tsx for the rationale.

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";

export default function CoachError({
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
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-6 text-center">
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          Coach
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-fg">
          Something went wrong
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Something went wrong. We&rsquo;ve logged it &mdash; try again, or
          head back to your dashboard.
        </p>

        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="inline-flex items-center justify-center rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            Try again
          </button>
          <Link
            href="/coach"
            className="inline-flex items-center justify-center rounded-md border border-line bg-surface-2 text-fg hover:bg-surface hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
