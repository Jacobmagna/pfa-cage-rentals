"use client";

// Schedule Manager Part 2 — admin-only toggle to grant/revoke a coach's
// scoped Master-schedule access (users.schedule_admin). Mirrors the
// notes-card card+useActionState pattern. Turning it ON gives the coach a
// "Master" tab to manage the cage-rental + work schedules for ANY coach;
// it does NOT grant access to money, pay, reports, or roster. The form
// posts a hidden coachId + the DESIRED new value (the opposite of the
// current state); submitting flips the flag.
//
// Anti-escalation: the underlying public action is requireRole("admin")
// gated, so this card only does anything for a real admin. A coach can't
// reach the coach-detail page, and even a direct RPC call is rejected.

import { useActionState } from "react";
import { ShieldCheck } from "lucide-react";
import {
  setScheduleAdminFormAction,
  type ScheduleAdminActionResult,
} from "../coach-settings-form-actions";

const INITIAL_STATE: ScheduleAdminActionResult = { ok: true };

export function ScheduleManagerCard({
  coachId,
  initialEnabled,
}: {
  coachId: string;
  initialEnabled: boolean;
}) {
  const [state, action, pending] = useActionState(
    setScheduleAdminFormAction,
    INITIAL_STATE,
  );

  // The card reflects the server-revalidated `initialEnabled`. The form
  // posts the OPPOSITE value, so submitting flips the flag. Re-key on the
  // saved state (and on error) so the control re-mounts cleanly after a
  // revalidate.
  const enabled = initialEnabled;
  const formKey = state.ok
    ? `ok-${enabled ? "on" : "off"}`
    : `err-${state.error.code}-${state.error.message}`;

  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Schedule Manager</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          Turning this <strong>ON</strong> gives this coach a{" "}
          <strong>Master</strong> tab to manage the cage-rental and work
          schedules — create, edit, move, and remove bookings for any coach.
          It does <strong>not</strong> grant access to money, pay, reports, or
          the roster.
        </p>
      </header>

      <form action={action} key={formKey} className="space-y-4 p-5">
        <input type="hidden" name="coachId" defaultValue={coachId} />
        {/* Submitting posts the OPPOSITE of the current state — the toggle flips it. */}
        <input
          type="hidden"
          name="enabled"
          defaultValue={enabled ? "false" : "true"}
        />

        {!state.ok ? (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {state.error.message}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck
              className={[
                "h-5 w-5 shrink-0",
                enabled ? "text-gold" : "text-fg-subtle",
              ].join(" ")}
              strokeWidth={2}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">
                Master schedule access
              </p>
              <p className="text-xs text-fg-muted">
                Currently{" "}
                <span
                  className={
                    enabled ? "font-semibold text-gold" : "font-semibold text-fg"
                  }
                >
                  {enabled ? "ON" : "OFF"}
                </span>
                .
              </p>
            </div>
          </div>

          <button
            type="submit"
            role="switch"
            aria-checked={enabled}
            aria-label={
              enabled
                ? "Turn off Master schedule access for this coach"
                : "Turn on Master schedule access for this coach"
            }
            disabled={pending}
            className={[
              "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 disabled:opacity-50 disabled:cursor-not-allowed",
              enabled ? "bg-gold" : "bg-line-strong",
            ].join(" ")}
          >
            <span
              className={[
                "inline-block h-5 w-5 transform rounded-full bg-white shadow-[var(--shadow-sm)] transition-transform",
                enabled ? "translate-x-6" : "translate-x-1",
              ].join(" ")}
            />
          </button>
        </div>

        <div className="flex items-center justify-end">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending
              ? "Saving…"
              : enabled
                ? "Turn OFF Schedule Manager"
                : "Turn ON Schedule Manager"}
          </button>
        </div>
      </form>
    </section>
  );
}
