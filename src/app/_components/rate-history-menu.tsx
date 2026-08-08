"use client";

// SPEC rate-effective-dating §7 — RATE HISTORY, behind a 3-dot menu.
//
// Jacob's call, explicitly to avoid clutter: the periods do not belong on the
// row. So this is a 24px button that fetches nothing until it is opened, and
// renders "$30.00 / hr — effective Jun 19 · set Aug 7 by Mark", newest first.
//
// ── No client DB access ──────────────────────────────────────────────────
// The parent passes `load`, which is one of the requireRole("admin")-gated
// server actions. This component never imports @/db and never learns an id it
// wasn't handed. The RateHistory type import is type-only and erased at build,
// the same property src/lib/errors.ts relies on.
//
// ── Positioning ──────────────────────────────────────────────────────────
// ABSOLUTE inside the trigger's own stacking context, not a fixed overlay.
// One of the two surfaces renders this inside a native <dialog> living in the
// browser top layer, where a `fixed inset-0 z-50` panel draws BEHIND the
// dialog — the lesson recorded in the rental-delete work. Absolute + a local
// backdrop button works identically in both places.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, MoreVertical } from "lucide-react";
import type { RateHistory } from "@/lib/server/rate-history";
import { formatShortDate } from "@/lib/rate-reprice-copy";
import { formatPfaDateMedium } from "@/lib/timezone";

export function RateHistoryMenu({
  subject,
  load,
  align = "right",
}: {
  /** "Alex Milone on Elite Hitting" — read out in the accessible name. */
  subject: string;
  /** An admin-gated server action. Called on OPEN, never on mount. */
  load: () => Promise<RateHistory>;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<RateHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHistory(await load());
    } catch {
      setError("Couldn't load the rate history.");
    } finally {
      setLoading(false);
    }
  }, [load]);

  // ESC closes. Registered only while open, so a page full of these rows
  // isn't a page full of idle listeners.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Stop the keypress reaching an enclosing native <dialog>, which
        // would otherwise close the whole rate form out from under the admin
        // when all they wanted was to dismiss this menu.
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    // Fetch on OPEN, and re-fetch on every open: a rate the admin just saved
    // must not show a history from before they saved it.
    if (next) void fetchHistory();
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Rate history for ${subject}`}
        title="Rate history"
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
      >
        <MoreVertical className="h-4 w-4" aria-hidden="true" />
      </button>

      {open ? (
        <>
          {/* Local click-away. Absolute-positioned like the panel so it stays
              inside the same stacking context (see the header). */}
          <button
            type="button"
            aria-label={`Close rate history for ${subject}`}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            id={panelId}
            role="dialog"
            aria-label={`Rate history for ${subject}`}
            className={`absolute z-20 mt-1 w-[19rem] max-h-[18rem] overflow-y-auto rounded-lg border border-line bg-surface p-3 text-left shadow-[var(--shadow-lg)] ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
              Rate history
            </p>

            {history?.current ? (
              <p className="mt-1 text-[11px] text-fg-muted">
                Now:{" "}
                <span className="font-medium text-fg">
                  {history.current.rateLabel}
                </span>
                {history.current.effectiveFrom ? (
                  <> — effective {formatShortDate(history.current.effectiveFrom)}</>
                ) : null}
              </p>
            ) : null}

            {loading ? (
              <p
                role="status"
                className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg-muted"
              >
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                Loading…
              </p>
            ) : null}

            {error ? (
              <p role="alert" className="mt-2 text-[11px] text-danger">
                {error}
              </p>
            ) : null}

            {!loading && !error && history && history.entries.length === 0 ? (
              <p className="mt-2 text-[11px] text-fg-muted">
                No rate changes recorded yet.
              </p>
            ) : null}

            {history && history.entries.length > 0 ? (
              <ol className="mt-2 space-y-2">
                {history.entries.map((entry) => (
                  <li
                    key={entry.id}
                    className="border-t border-line/60 pt-2 first:border-t-0 first:pt-0"
                  >
                    <p className="text-[11.5px] font-medium text-fg">
                      {entry.removed ? (
                        <>Removed — was {entry.rateLabel}</>
                      ) : (
                        entry.rateLabel
                      )}
                      {entry.effectiveFrom ? (
                        <span className="font-normal text-fg-muted">
                          {" "}
                          — effective {formatShortDate(entry.effectiveFrom)}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-[10.5px] text-fg-subtle">
                      set {formatPfaDateMedium(entry.setAt)} by {entry.actor}
                    </p>
                    {entry.reprice ? (
                      <p className="text-[10.5px] text-fg-muted">
                        Re-priced {entry.reprice.logCount}{" "}
                        {entry.reprice.logCount === 1 ? "entry" : "entries"}{" "}
                        already logged.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
