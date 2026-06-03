"use client";

import { useActionState, useMemo } from "react";
import { CheckCircle2, FolderPlus } from "lucide-react";
import {
  createProgramFormAction,
  type CreateProgramResult,
} from "../form-actions";
import { ProgramFields } from "./program-fields";

const INITIAL_STATE: CreateProgramResult = { ok: true, createdAt: 0 };

// Add-program form (create mode), pinned at the top of the page. Mirrors
// admin/attendance/roster's AddAthleteForm: useActionState handles the
// submit; on success it returns a `createdAt` nonce we use as the form's
// remount key → fields reset, ready for the next program. On failure the
// errored values echo back.
export function AddProgramForm() {
  const [state, formAction, pending] = useActionState(
    createProgramFormAction,
    INITIAL_STATE,
  );

  const defaults = useMemo(() => {
    if (!state.ok) return state.values;
    return { name: "", cap: "", capPeriod: "", limit: false, rateDollars: "" };
  }, [state]);

  const showSuccess = state.ok && state.createdAt > 0;
  const formKey = state.ok
    ? state.createdAt > 0
      ? `ok-${state.createdAt}`
      : "fresh"
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-[var(--shadow-sm)]">
      <div className="mb-4 flex items-center gap-2">
        <FolderPlus className="h-4 w-4 text-gold" aria-hidden="true" />
        <h2 className="text-sm font-semibold tracking-tight text-fg">
          Add program
        </h2>
      </div>

      {showSuccess ? (
        <div
          role="status"
          className="mb-4 flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-3 py-2.5 text-sm text-success"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>Program added.</span>
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

      <form action={formAction} key={formKey} className="space-y-4">
        <ProgramFields defaults={defaults} />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="h-10 rounded-md bg-gold px-4 text-sm font-semibold text-gold-ink shadow-[var(--shadow-sm)] transition-colors hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
          >
            {pending ? "Adding…" : "Add program"}
          </button>
        </div>
      </form>
    </section>
  );
}
