"use client";

// Shared confirmation dialog (U4, Batch 4). Extracted from the
// typed-confirmation modal in delete-coach-card.tsx so every
// destructive action in the app uses the same chrome instead of
// the OS-native window.confirm() (which broke the dark/gold
// aesthetic and had inconsistent a11y).
//
// Two variants:
//   - simple: yes/no. Default. Confirm button autofocused for the
//     common case where the action is unambiguous.
//   - typed: requires the user to type a phrase before Confirm
//     enables (e.g. the coach's name on Delete coach). Input is
//     autofocused; phrase is shown in monospace.
//
// Behavior contract:
//   - ESC + click-outside both dismiss (unless pending).
//   - Focus trap: Tab/Shift-Tab cycles within the dialog.
//   - Parent owns close: onConfirm doesn't auto-close so errors
//     can be surfaced inline before dismissal.
//
// Why hand-rolled instead of pulling in Radix/shadcn Dialog:
// no Radix dep in package.json, and the rest of the codebase
// uses either native <dialog> or this same fixed-overlay pattern.
// One more dep for one component would be more weight than reuse.

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

type TypedConfirmation = {
  phrase: string;
  label?: string;
};

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  typedConfirmation?: TypedConfirmation;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "danger";
  onConfirm: () => void | Promise<void>;
  isPending?: boolean;
};

// Selector for the elements eligible for focus trap. Matches what
// most focus-trap libraries use; keeps it tight.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  typedConfirmation,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  variant = "danger",
  onConfirm,
  isPending = false,
}: ConfirmDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const titleId = useId();

  const expected = typedConfirmation?.phrase ?? "";
  const typedMatches =
    !typedConfirmation || typed.trim() === expected.trim();

  // Reset typed input each time the dialog opens. Prevents stale
  // text leaking between successive opens. The conditional setState
  // here syncs an internal input value to an external "open"
  // transition — not a re-render cascade.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTyped("");
    }
  }, [open]);

  // Autofocus on open: input if typed-confirmation, else cancel.
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      if (typedConfirmation) inputRef.current?.focus();
      else cancelRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open, typedConfirmation]);

  // ESC dismiss + focus trap. Captured at document level so it
  // works no matter where focus is inside the dialog.
  useEffect(() => {
    if (!open) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isPending) return;
        e.preventDefault();
        onOpenChange(false);
        return;
      }
      if (e.key !== "Tab") return;

      const container = containerRef.current;
      if (!container) return;
      const focusable = Array.from(
        container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, isPending, onOpenChange]);

  if (!open) return null;

  const handleBackdropClick = () => {
    if (isPending) return;
    onOpenChange(false);
  };

  const handleConfirmClick = () => {
    if (!typedMatches || isPending) return;
    void onConfirm();
  };

  const confirmClasses =
    variant === "danger"
      ? "bg-danger text-page hover:opacity-90 shadow-[var(--shadow-sm)] focus-visible:ring-danger/40"
      : "bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] focus-visible:ring-gold/40";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        ref={containerRef}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="px-5 py-4 border-b border-line flex items-start gap-3">
          {variant === "danger" ? (
            <div className="flex-shrink-0 w-9 h-9 rounded-full bg-danger/10 flex items-center justify-center">
              <AlertTriangle className="h-4 w-4 text-danger" />
            </div>
          ) : null}
          <div className="min-w-0">
            <h4
              id={titleId}
              className="text-base font-semibold text-fg"
            >
              {title}
            </h4>
            {description ? (
              <div className="mt-1 text-xs text-fg-muted leading-relaxed">
                {description}
              </div>
            ) : null}
          </div>
        </div>

        {typedConfirmation ? (
          <div className="px-5 py-4">
            <label className="block">
              <span className="text-xs text-fg-muted">
                {typedConfirmation.label ?? (
                  <>
                    Type{" "}
                    <span className="font-mono text-fg">
                      {typedConfirmation.phrase}
                    </span>{" "}
                    to confirm
                  </>
                )}
              </span>
              <input
                ref={inputRef}
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                disabled={isPending}
                placeholder={typedConfirmation.phrase}
                className="mt-1.5 w-full px-3 h-10 rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-danger/40"
              />
            </label>
          </div>
        ) : null}

        <div className="px-5 py-4 border-t border-line flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
            className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirmClick}
            disabled={!typedMatches || isPending}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 transition ${confirmClasses}`}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
