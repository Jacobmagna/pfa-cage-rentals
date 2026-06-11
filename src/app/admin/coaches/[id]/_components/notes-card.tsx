"use client";

// QA2 #8 — admin-only free-text notes about a coach. A single textarea
// prefilled from users.notes; one save form (useActionState) mirroring
// handles-card.tsx. Empty input clears the column (schema "" → null).
// Never shown on coach-facing surfaces — for admin reference only.

import { useActionState } from "react";
import { Check } from "lucide-react";
import {
  updateCoachNotesFormAction,
  type NotesActionResult,
} from "../coach-settings-form-actions";
import { COACH_NOTES_MAX } from "@/lib/schemas/coach-notes";

const INITIAL_STATE: NotesActionResult = { ok: true };

export function CoachNotesCard({
  coachId,
  initialNotes,
}: {
  coachId: string;
  initialNotes: string | null;
}) {
  const [state, action, pending] = useActionState(
    updateCoachNotesFormAction,
    INITIAL_STATE,
  );

  // On error, keep what the admin typed; otherwise re-key against the
  // saved value so the textarea picks up the revalidated default.
  const notesDefault =
    !state.ok && state.values ? state.values.notes : (initialNotes ?? "");
  const formKey = state.ok
    ? `ok-${(initialNotes ?? "").length}`
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Notes</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Private admin notes about this coach. Reference only — never shown
          to the coach or any other coach.
        </p>
      </header>

      <form action={action} key={formKey} className="space-y-4 p-5">
        <input type="hidden" name="coachId" defaultValue={coachId} />

        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        <label className="block">
          <span className="text-xs uppercase tracking-wider text-fg-muted mb-1.5 block">
            Notes
          </span>
          <textarea
            name="notes"
            defaultValue={notesDefault}
            maxLength={COACH_NOTES_MAX}
            rows={5}
            placeholder="Anything worth remembering about this coach…"
            className="w-full rounded-lg bg-surface border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm leading-relaxed resize-y focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
          />
          <span className="block text-[11px] text-fg-subtle mt-1 leading-snug">
            Up to {COACH_NOTES_MAX.toLocaleString()} characters. Leave blank
            to clear.
          </span>
        </label>

        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            <Check className="h-4 w-4" strokeWidth={2.5} />
            {pending ? "Saving…" : "Save notes"}
          </button>
        </div>
      </form>
    </section>
  );
}
