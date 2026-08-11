"use client";

// The only interactive leaf on the statement (payment-statement SPEC §9).
// `window.print()` is the entire send mechanism: Mark prints or saves as PDF
// and forwards it himself. No PDF library, no outbound email path — the app's
// email rail is the login rail and this file has no business near it.
//
// Kept as its own tiny client component so statement-card.tsx stays a server
// component; the document itself needs no JS to render or to print.

import { useEffect } from "react";

/**
 * Opts this page into the document print rules in globals.css by marking
 * <body>. Scoping it to a class rather than applying the rules globally means
 * no other page's printing behaviour changes — and it is removed on unmount,
 * so navigating away restores normal printing.
 */
export function PrintDocumentMode() {
  useEffect(() => {
    document.body.classList.add("printing-document");
    return () => document.body.classList.remove("printing-document");
  }, []);
  return null;
}

export function ClientPrintButton({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-xs font-medium text-fg-muted shadow-[var(--shadow-sm)] transition hover:-translate-y-px hover:text-fg hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
    >
      {children}
    </button>
  );
}
