"use client";

// Catches errors inside /admin/*. Renders INSIDE the admin AppShell
// (because AppShell lives in src/app/admin/layout.tsx, not per-page),
// so the top nav + footer stay in place. Just the page body fails over
// to a card with retry + back-to-admin-home affordances.

import { useEffect } from "react";
import Link from "next/link";
import * as Sentry from "@sentry/nextjs";

export default function AdminError({
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
          Admin
        </p>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-fg">
          Something went wrong
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          Something went wrong loading this admin page. We&rsquo;ve logged
          it. You can try again, or head back to the admin home.
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
            href="/admin"
            className="inline-flex items-center justify-center rounded-md border border-line bg-surface-2 text-fg hover:bg-surface hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            Back to admin home
          </Link>
        </div>
      </div>
    </div>
  );
}
