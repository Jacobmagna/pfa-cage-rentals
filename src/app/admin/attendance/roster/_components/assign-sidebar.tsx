"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import {
  assignAthletesFormAction,
  type AssignAthletesResult,
} from "../form-actions";
import type { ProgramOption } from "./roster-client";

// Right-side slide-in panel for assigning / moving selected athletes to
// one program (DEC-21). No drawer component exists in the codebase, so
// this is hand-rolled — same fixed-overlay + scrim pattern as
// ConfirmDialog, plus a slide transition, focus trap, Escape-to-close,
// scrim-click-to-close, and focus-return-to-trigger on close.

const INITIAL_STATE: AssignAthletesResult = { ok: true, assignedAt: 0 };

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function AssignSidebar({
  open,
  onClose,
  onAssigned,
  athleteIds,
  programs,
}: {
  open: boolean;
  onClose: () => void;
  onAssigned: () => void;
  athleteIds: string[];
  programs: ProgramOption[];
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [mode, setMode] = useState<"add" | "move">("add");
  const [programId, setProgramId] = useState("");
  const [state, formAction, pending] = useActionState(
    assignAthletesFormAction,
    INITIAL_STATE,
  );

  // Remember the element that had focus when we opened so we can return
  // focus there on close (a11y: focus shouldn't get lost to <body>).
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
    }
  }, [open]);

  // Reset the form selection each time the panel opens. Syncing local
  // form state to the external "open" transition — not a render cascade.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode("add");
      setProgramId("");
    }
  }, [open]);

  // Move initial focus into the panel on open.
  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      first?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [open]);

  // Escape closes + focus trap (Tab/Shift-Tab cycle within the panel).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (pending) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
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
  }, [open, pending, onClose]);

  // On successful assign: notify parent (clear selection) + close. Return
  // focus to the trigger.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && state.assignedAt > 0) {
      onAssigned();
      onClose();
    }
    wasPending.current = pending;
  }, [pending, state, onAssigned, onClose]);

  // Return focus to the trigger after the panel unmounts on close.
  const prevOpen = useRef(open);
  useEffect(() => {
    if (prevOpen.current && !open) {
      triggerRef.current?.focus();
    }
    prevOpen.current = open;
  }, [open]);

  if (!open) return null;

  const count = athleteIds.length;

  return (
    <div className="fixed inset-0 z-50">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => {
          if (!pending) onClose();
        }}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col border-l border-line bg-surface shadow-xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Roster
            </p>
            <h2
              id={titleId}
              className="mt-0.5 text-lg font-semibold tracking-tight text-fg"
            >
              Assign / move athletes
            </h2>
            <p className="mt-1 text-xs text-fg-subtle">
              {count} {count === 1 ? "athlete" : "athletes"} selected
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form
          action={formAction}
          className="flex min-h-0 flex-1 flex-col"
        >
          {athleteIds.map((id) => (
            <input key={id} type="hidden" name="athleteId" value={id} />
          ))}
          <input type="hidden" name="programId" value={programId} />
          <input type="hidden" name="mode" value={mode} />

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
            {!state.ok ? (
              <div
                role="alert"
                className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
              >
                {state.error.message}
              </div>
            ) : null}

            <fieldset>
              <legend className="mb-2 text-xs uppercase tracking-wider text-fg-muted">
                Mode
              </legend>
              <div className="inline-flex rounded-md border border-line bg-page p-0.5">
                <ModeToggle
                  label="Add"
                  description="Keep existing programs"
                  active={mode === "add"}
                  onClick={() => setMode("add")}
                />
                <ModeToggle
                  label="Move"
                  description="Replace existing programs"
                  active={mode === "move"}
                  onClick={() => setMode("move")}
                />
              </div>
              <p className="mt-2 text-[11px] text-fg-subtle">
                {mode === "add"
                  ? "Adds the program; any current assignments stay."
                  : "Removes all current assignments, then adds this one."}
              </p>
            </fieldset>

            <fieldset>
              <legend className="mb-2 text-xs uppercase tracking-wider text-fg-muted">
                Program
              </legend>
              {programs.length === 0 ? (
                <p className="text-sm text-fg-muted">
                  No active programs. Create one first.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {programs.map((p) => (
                    <label
                      key={p.id}
                      className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line bg-page px-3 py-2.5 text-sm text-fg transition-colors hover:border-line-strong has-[:checked]:border-gold has-[:checked]:bg-gold/10"
                    >
                      <input
                        type="radio"
                        name="programChoice"
                        value={p.id}
                        checked={programId === p.id}
                        onChange={() => setProgramId(p.id)}
                        className="h-4 w-4 accent-gold"
                      />
                      <span>{p.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-4">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="h-9 rounded-md border border-line bg-surface-2 px-4 text-sm font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending || !programId || count === 0}
              className="h-9 rounded-md bg-gold px-4 text-sm font-semibold text-gold-ink transition-colors hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              {pending
                ? "Saving…"
                : mode === "add"
                  ? "Add to program"
                  : "Move to program"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ModeToggle({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={description}
      className={[
        "rounded px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
        active
          ? "bg-gold text-gold-ink"
          : "text-fg-muted hover:text-fg",
      ].join(" ")}
    >
      {label}
    </button>
  );
}
