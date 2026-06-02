"use client";

// Per-coach payment-handle editor. One save form covers both fields
// because Venmo + Zelle change together in practice (a coach gives
// you both at the same time, or replaces both when they switch
// banks). Single useActionState keeps the error UI simple.
//
// Empty inputs clear the column — the Zod schema's transform turns
// "" into null. The displayed copy chips render only when a handle
// is set, so a freshly-cleared field doesn't leave a phantom chip.

import { useActionState, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import {
  updateCoachHandlesFormAction,
  type HandlesActionResult,
} from "../handles-form-actions";

const INITIAL_STATE: HandlesActionResult = { ok: true };

export function CoachHandlesCard({
  coachId,
  initialZelleContact,
}: {
  coachId: string;
  initialZelleContact: string | null;
}) {
  const [state, action, pending] = useActionState(
    updateCoachHandlesFormAction,
    INITIAL_STATE,
  );

  // After a successful save, re-key the form against the values the
  // server echoed back via revalidatePath — without this the inputs
  // keep their stale defaultValue from the first render.
  const zelleDefault =
    !state.ok && state.values
      ? state.values.zelleContact
      : (initialZelleContact ?? "");
  const formKey = state.ok
    ? `ok-${initialZelleContact ?? ""}`
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Zelle contact</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Where this coach receives Zelle. Reference only — used on the
          Payments page to help you reconcile a payment, never shown to
          other coaches.
        </p>
      </header>

      <form action={action} key={formKey} className="space-y-4 p-5">
        <input type="hidden" name="userId" defaultValue={coachId} />

        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        <Field
          label="Zelle contact"
          hint="Email or phone number — whatever's registered with their bank."
          chip={
            initialZelleContact ? (
              <CopyChip value={initialZelleContact} label="Copy" />
            ) : null
          }
        >
          <input
            type="text"
            name="zelleContact"
            defaultValue={zelleDefault}
            maxLength={200}
            placeholder="email or phone"
            className={inputStyles}
          />
        </Field>

        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <Check className="h-4 w-4" strokeWidth={2.5} />
            {pending ? "Saving…" : "Save Zelle contact"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Field({
  label,
  hint,
  chip,
  children,
}: {
  label: string;
  hint?: string;
  chip?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs uppercase tracking-wider text-fg-muted">
          {label}
        </span>
        {chip}
      </span>
      {children}
      {hint ? (
        <span className="block text-[11px] text-fg-subtle mt-1 leading-snug">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function CopyChip({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be blocked (insecure context, permission denied).
      // Silent — user can select+copy manually from the input.
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-full bg-surface-2 hover:bg-surface text-fg-muted hover:text-fg ring-1 ring-inset ring-line px-2 py-px text-[10px] font-medium uppercase tracking-wider transition-colors"
      title={`Copy ${value}`}
    >
      {copied ? (
        <>
          <Check className="h-2.5 w-2.5" strokeWidth={2.5} />
          Copied
        </>
      ) : (
        <>
          <ClipboardCopy className="h-2.5 w-2.5" strokeWidth={2.5} />
          {label}
        </>
      )}
    </button>
  );
}

const inputStyles =
  "w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
