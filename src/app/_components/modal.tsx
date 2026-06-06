"use client";

// Generic, reusable modal SHELL — a backdrop + a centered slot for
// `children`. Unlike confirm-dialog.tsx this renders NO title/footer/
// buttons of its own; callers pass content that supplies its own card
// chrome. The overlay + ESC + backdrop-click + focus-trap behavior is
// modeled on confirm-dialog.tsx so the two share one interaction grammar.
//
// Hand-rolled (no Radix/shadcn dep) to match the rest of the codebase,
// which uses this same fixed-overlay pattern.

import { useEffect, useRef } from "react";

// Same focus-trap selector confirm-dialog.tsx uses — keeps it tight.
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function Modal({
  open,
  onClose,
  children,
  labelledBy,
  closeOnBackdrop = true,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  labelledBy?: string;
  closeOnBackdrop?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // On open, move focus into the dialog (first focusable, else the
  // wrapper itself). Mirrors the confirm-dialog autofocus pattern.
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      const container = containerRef.current;
      if (!container) return;
      const first = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? container).focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open]);

  // ESC dismiss + Tab/Shift-Tab focus trap. Captured at document level
  // so it works no matter where focus is inside the dialog.
  useEffect(() => {
    if (!open) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
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
  }, [open, onClose]);

  if (!open) return null;

  const handleBackdropClick = () => {
    if (closeOnBackdrop) onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md max-h-[90vh] overflow-y-auto focus:outline-none"
      >
        {children}
      </div>
    </div>
  );
}
