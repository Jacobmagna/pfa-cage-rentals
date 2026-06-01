"use client";

// Small over-cap explainer popover (FEAT-11). Anchored to a red P cell;
// explains which session put the athlete over the program's cap (the
// period window + present-count vs cap). Read-only — no actions.
//
// No generic popover component exists in the app, so this is hand-rolled
// to match the a11y rigor of confirm-dialog.tsx (role="dialog", Escape +
// click-outside to close, focus returns to the trigger) without pulling
// in a dependency. Lighter than the full modal: positioned absolutely
// next to the cell, one open at a time (the grid owns that state).

import { useEffect, useRef } from "react";
import type { OverCapInfo } from "@/lib/server/attendance-flags";

export function OverCapPopover({
  info,
  onClose,
  returnFocusTo,
}: {
  info: OverCapInfo;
  onClose: () => void;
  // The cell button that opened the popover; focus returns here on close.
  returnFocusTo: React.RefObject<HTMLButtonElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const overBy = info.indexInPeriod - info.cap;
  const unit = info.periodLabel.startsWith("Week") ? "week" : "month";

  // Escape closes; click-outside closes. Focus returns to the trigger
  // when this unmounts (i.e. on close).
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    const handleClick = (e: MouseEvent) => {
      const node = ref.current;
      if (node && !node.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    // Defer the click listener so the opening click doesn't immediately
    // close it.
    const t = setTimeout(
      () => document.addEventListener("mousedown", handleClick),
      0,
    );
    // The trigger button is stable for the popover's lifetime; grab it
    // now so cleanup restores focus to the same element that opened us.
    const trigger = returnFocusTo.current;
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
      clearTimeout(t);
      trigger?.focus();
    };
  }, [onClose, returnFocusTo]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Over cap: ${info.periodLabel}`}
      className="absolute left-1/2 top-full z-30 mt-1 w-56 -translate-x-1/2 rounded-md border border-line bg-surface px-3 py-2 text-left text-xs leading-relaxed text-fg-muted shadow-xl"
    >
      <p className="font-semibold text-danger">{info.periodLabel}</p>
      <p className="mt-1">
        Present #{info.indexInPeriod} of a {info.cap}/{unit} cap{" "}
        <span className="whitespace-nowrap">
          (over by {overBy})
        </span>
        .
      </p>
      <p className="mt-1 text-fg-subtle">
        {info.periodPresentCount} present this {unit}.
      </p>
    </div>
  );
}
