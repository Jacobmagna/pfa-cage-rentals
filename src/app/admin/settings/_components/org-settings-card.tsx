"use client";

// Editor for the org_settings singleton. Single useActionState form
// covering display name + both handles — they change together when
// Dad changes receivers and the simpler UI fits the small surface.

import { useActionState, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import {
  updateOrgSettingsFormAction,
  type OrgSettingsActionResult,
} from "../form-actions";

const INITIAL_STATE: OrgSettingsActionResult = { ok: true };

export function OrgSettingsCard({
  initialPfaDisplayName,
  initialPfaVenmoHandle,
  initialPfaZelleContact,
}: {
  initialPfaDisplayName: string;
  initialPfaVenmoHandle: string | null;
  initialPfaZelleContact: string | null;
}) {
  const [state, action, pending] = useActionState(
    updateOrgSettingsFormAction,
    INITIAL_STATE,
  );

  const nameDefault =
    !state.ok && state.values
      ? state.values.pfaDisplayName
      : initialPfaDisplayName;
  const venmoDefault =
    !state.ok && state.values
      ? state.values.pfaVenmoHandle
      : (initialPfaVenmoHandle ?? "");
  const zelleDefault =
    !state.ok && state.values
      ? state.values.pfaZelleContact
      : (initialPfaZelleContact ?? "");

  const formKey = state.ok
    ? `ok-${initialPfaDisplayName}-${initialPfaVenmoHandle ?? ""}-${initialPfaZelleContact ?? ""}`
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section className="rounded-xl border border-line bg-surface overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h2 className="text-base font-semibold text-fg">PFA payment handles</h2>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Where coaches will pay PFA from inside the app. These appear on
          coach-facing surfaces only — never shown to other coaches.
        </p>
      </header>

      <form action={action} key={formKey} className="space-y-4 p-5">
        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        <Field
          label="Display name"
          hint='Shown on the pay button — e.g. "Pay PFA Sports via Venmo".'
        >
          <input
            type="text"
            name="pfaDisplayName"
            required
            defaultValue={nameDefault}
            maxLength={100}
            placeholder="PFA Sports"
            className={inputStyles}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Venmo handle"
            hint="No @ — just the username."
            chip={
              initialPfaVenmoHandle ? (
                <CopyChip value={`@${initialPfaVenmoHandle}`} />
              ) : null
            }
          >
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
                @
              </span>
              <input
                type="text"
                name="pfaVenmoHandle"
                defaultValue={venmoDefault}
                maxLength={30}
                placeholder="pfa-sports"
                className={`${inputStyles} pl-7`}
              />
            </div>
          </Field>

          <Field
            label="Zelle contact"
            hint="Email or phone registered with the bank."
            chip={
              initialPfaZelleContact ? (
                <CopyChip value={initialPfaZelleContact} />
              ) : null
            }
          >
            <input
              type="text"
              name="pfaZelleContact"
              defaultValue={zelleDefault}
              maxLength={200}
              placeholder="email or phone"
              className={inputStyles}
            />
          </Field>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <Check className="h-4 w-4" strokeWidth={2.5} />
            {pending ? "Saving…" : "Save settings"}
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

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Silent fallback — input is still selectable.
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
          Copy
        </>
      )}
    </button>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
