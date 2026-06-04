"use client";

import { useActionState, useMemo } from "react";
import { CheckCircle2, UserPlus } from "lucide-react";
import { addCoachAction, type AddCoachResult } from "../actions";

const INITIAL_STATE: AddCoachResult = {
  ok: true,
  mode: "created",
  addedAt: 0,
};

// Admin "Add coach" form. Invite-only sign-in (src/auth.ts) only lets
// in emails that already have a users row, so this is how an admin
// pre-authorizes a new coach. useActionState handles the submit; on
// success it returns an `addedAt` nonce we use as the form's remount
// key → the fields reset, ready for the next coach. On failure the
// errored values echo back. Mirrors add-athlete-form.
export function AddCoachForm() {
  const [state, formAction, pending] = useActionState(
    addCoachAction,
    INITIAL_STATE,
  );

  const defaults = useMemo(() => {
    if (!state.ok) return state.values;
    return { name: "", email: "" };
  }, [state]);

  const showSuccess = state.ok && state.addedAt > 0;
  const formKey = state.ok
    ? state.addedAt > 0
      ? `ok-${state.addedAt}`
      : "fresh"
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section className="mb-6 rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-1.5 flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-gold" aria-hidden="true" />
        <h2 className="text-sm font-semibold tracking-tight text-fg">
          Add a coach
        </h2>
      </div>
      <p className="mb-4 text-xs text-fg-muted">
        Pre-authorize a coach by email. Only added emails can sign in.
      </p>

      {showSuccess ? (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Added — they can now sign in with that email.</span>
        </div>
      ) : null}

      {!state.ok ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      <form
        action={formAction}
        key={formKey}
        className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <Field label="Name">
          <input
            type="text"
            name="name"
            required
            maxLength={80}
            defaultValue={defaults.name}
            className={inputStyles}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            name="email"
            required
            autoComplete="off"
            defaultValue={defaults.email}
            placeholder="coach@example.com"
            className={inputStyles}
          />
        </Field>
        <button
          type="submit"
          disabled={pending}
          className="h-10 rounded-md bg-gold px-4 text-sm font-semibold text-gold-ink shadow-[var(--shadow-sm)] transition-colors hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        >
          {pending ? "Adding…" : "Add coach"}
        </button>
      </form>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs uppercase tracking-wider text-fg-muted">
        {label}
      </span>
      {children}
    </label>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
