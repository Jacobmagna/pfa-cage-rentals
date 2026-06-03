"use client";

import { useRef } from "react";
import { CheckCircle2 } from "lucide-react";

// Shared post-success confirmation panel. Replaces a coach form on a
// successful submit: the form is hidden and this card renders in its
// place so the form underneath is NOT interactable. A single corner
// action button is the only in-page way back to the base form (the
// other being navigating off the tab and returning, which remounts the
// host component to its base state).
//
// Presentational only — the host owns the success/ack derivation and
// passes `onAction`. Focus moves to the action button when the panel
// mounts so keyboard users can immediately "log another".
export function CompletionPanel({
  message,
  actionLabel,
  onAction,
}: {
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  // Move focus to the action button on mount. A callback ref fires once
  // when the element attaches — no effect needed, so the repo's
  // no-setState-in-effect lint isn't relevant and focus is reliable.
  const focusOnMount = (node: HTMLButtonElement | null) => {
    buttonRef.current = node;
    if (node) node.focus();
  };

  return (
    <div
      role="status"
      className="rounded-xl border border-success/30 bg-success/10 shadow-[var(--shadow-sm)] p-5 sm:p-6"
    >
      <div className="flex items-start gap-3">
        <CheckCircle2 className="h-6 w-6 shrink-0 text-success" />
        <p className="text-sm font-medium text-fg">{message}</p>
      </div>

      <div className="mt-5 flex justify-end">
        <button
          ref={focusOnMount}
          type="button"
          onClick={onAction}
          className="rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] h-10 px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
