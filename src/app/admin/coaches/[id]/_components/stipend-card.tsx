"use client";

// The coach STIPEND card (SPEC §6, Phase C) — where Mark puts a coach on a
// flat half-month amount, changes it, ends it, and reads the history.
//
// ── 🔴 THE START DATE IS A SELECT, NOT A DATE INPUT ───────────────────────
// A stipend may only begin on a pay-period boundary (the 1st or the 16th).
// The server enforces that and refuses anything else loudly — but a free date
// input would let an admin type the 7th, get rejected, and have to guess what
// the app wanted. Offering only real boundaries makes the invalid state
// UNREPRESENTABLE in the UI while the server guard stays exactly as strict.
// The options are computed server-side from `pay-period.ts`, so there is no
// second implementation of the half-month calendar living in a component.
//
// ── 🔴 THE BACK-PAY CONFIRMATION IS THE POINT OF THIS CARD ────────────────
// Starting (or ending) a stipend in a period that has already begun makes the
// app claim money is owed that Mark may already have handed over in cash — the
// app has no payout ledger for work pay. So the first submit REFUSES, and this
// card renders what the server said: which periods, and what they cost. Only a
// second, explicit submit carries `confirmBackdate`. The amber panel is
// deliberately not the same red as a validation error — it is a decision, not
// a mistake.
//
// ── What this card cannot do, on purpose ─────────────────────────────────
// It cannot edit a past period, because nothing can: versions are append-only
// and forward-only, and changing an amount never rewrites what an earlier
// half-month was worth (Mark's Q5). The history table below is the proof of
// that, which is why it renders every version rather than just the live one.

import { useActionState } from "react";
import { CalendarClock, TriangleAlert } from "lucide-react";
import {
  endCoachStipendFormAction,
  setCoachStipendFormAction,
  type StipendActionResult,
} from "../stipend-form-actions";

const INITIAL_STATE: StipendActionResult = { ok: true };

export type StipendPeriodOption = {
  /** "2026-09-01" — a PFA pay-period start. */
  value: string;
  /** "Sep 1–15, 2026" */
  label: string;
  /** True when this period has already begun — picking it triggers §12.4. */
  alreadyRunning: boolean;
};

export type StipendVersionRow = {
  id: string;
  amountLabel: string;
  fromLabel: string;
  /** null = still in effect. */
  toLabel: string | null;
  note: string | null;
  isCurrent: boolean;
};

export function StipendCard({
  coachId,
  coachName,
  currentAmountLabel,
  currentFromLabel,
  periodOptions,
  versions,
  readOnly = false,
}: {
  coachId: string;
  coachName: string | null;
  /** null = this coach is not on a stipend. */
  currentAmountLabel: string | null;
  currentFromLabel: string | null;
  periodOptions: StipendPeriodOption[];
  versions: StipendVersionRow[];
  /** Archived coaches render read-only, matching every other card here. */
  readOnly?: boolean;
}) {
  const [state, action, pending] = useActionState(
    setCoachStipendFormAction,
    INITIAL_STATE,
  );
  const [endState, endAction, endPending] = useActionState(
    endCoachStipendFormAction,
    INITIAL_STATE,
  );

  const needsConfirm = !state.ok && state.needsBackdateConfirm === true;
  const plainError = !state.ok && state.needsBackdateConfirm !== true;
  const endNeedsConfirm = !endState.ok && endState.needsBackdateConfirm === true;
  const endPlainError = !endState.ok && endState.needsBackdateConfirm !== true;

  const values = state.ok
    ? { amount: "", effectiveFrom: "", note: "" }
    : state.values;

  // Re-key on the settled state so the form remounts cleanly after a
  // revalidate, but NOT while a confirmation is pending — remounting there
  // would throw away the amount the admin is being asked to confirm.
  const formKey = state.ok ? `ok-${versions.length}` : "pending-decision";

  const onStipend = currentAmountLabel !== null;
  const who = coachName ?? "this coach";

  return (
    <section className="my-8 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] overflow-hidden">
      <header className="px-5 py-4 border-b border-line">
        <h3 className="text-base font-semibold text-fg">Stipend</h3>
        <p className="mt-1 text-xs text-fg-muted leading-relaxed">
          A <strong>flat amount per half-month pay period</strong> — the 1st
          through the 15th, and the 16th through the end of the month. It is{" "}
          <strong>all-or-nothing</strong>: one logged hour and forty logged
          hours in the same period earn the same single stipend.
        </p>
        <p className="mt-2 text-xs text-fg-muted leading-relaxed">
          Work on a <strong>stipend program</strong> still records every hour,
          but those hours bill at <strong>$0</strong> — the stipend is the pay.
          Work on any other program is paid at its normal rate{" "}
          <strong>on top</strong>.
        </p>
      </header>

      <div className="p-5 space-y-5">
        {/* ── Current state ─────────────────────────────────────────────── */}
        <div className="flex items-start gap-2.5">
          <CalendarClock
            className={[
              "h-5 w-5 shrink-0 mt-0.5",
              onStipend ? "text-gold" : "text-fg-subtle",
            ].join(" ")}
            strokeWidth={2}
            aria-hidden="true"
          />
          <div className="min-w-0">
            {onStipend ? (
              <>
                <p className="text-sm font-medium text-fg">
                  {currentAmountLabel}{" "}
                  <span className="font-normal text-fg-muted">
                    per pay period
                  </span>
                </p>
                <p className="text-xs text-fg-muted">
                  In effect since {currentFromLabel}.
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-fg">
                  Not on a stipend
                </p>
                <p className="text-xs text-fg-muted">
                  {who} is paid at their normal per-program rates.
                </p>
              </>
            )}
          </div>
        </div>

        {readOnly ? null : (
          <>
            {/* ── Set / change ──────────────────────────────────────────── */}
            <form action={action} key={formKey} className="space-y-4">
              <input type="hidden" name="coachId" defaultValue={coachId} />

              {plainError ? (
                <div
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
                >
                  {state.error.message}
                </div>
              ) : null}

              {/* 🔴 §12.4 — a DECISION, not a validation failure. Amber, not
                  red, and it states the cost before it offers the button. */}
              {needsConfirm ? (
                <div
                  role="alert"
                  className="rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-xs text-fg space-y-2"
                >
                  <p className="flex items-start gap-2 font-semibold">
                    <TriangleAlert
                      className="h-4 w-4 shrink-0 mt-px text-warning"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <span>This is back-pay. Read it before you apply it.</span>
                  </p>
                  <p className="leading-relaxed">{state.message}</p>
                  <p className="leading-relaxed text-fg-muted">
                    PFA pays coaches outside this app too, so some of this may
                    already have been handed over in cash. Check before
                    applying.
                  </p>
                  <div className="pt-1">
                    <button
                      type="submit"
                      name="confirmBackdate"
                      value="true"
                      disabled={pending}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-warning/50 bg-warning/20 hover:bg-warning/30 h-8 px-3 text-xs font-medium text-fg disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 transition-colors"
                    >
                      {pending
                        ? "Applying…"
                        : `Yes — apply it to ${state.periodKeys.length} period${state.periodKeys.length === 1 ? "" : "s"}`}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="block text-xs font-medium text-fg-muted mb-1.5">
                    Amount per pay period
                  </span>
                  <div className="relative">
                    <span
                      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-muted"
                      aria-hidden="true"
                    >
                      $
                    </span>
                    <input
                      name="amount"
                      type="text"
                      inputMode="decimal"
                      required
                      defaultValue={values.amount}
                      placeholder="2500"
                      className="w-full rounded-lg border border-line bg-surface-2 h-9 pl-7 pr-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
                    />
                  </div>
                </label>

                <label className="block">
                  <span className="block text-xs font-medium text-fg-muted mb-1.5">
                    Starting with the pay period
                  </span>
                  {/* 🔴 A select, not a date input — see the module note. */}
                  <select
                    name="effectiveFrom"
                    required
                    defaultValue={values.effectiveFrom || ""}
                    className="w-full rounded-lg border border-line bg-surface-2 h-9 px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
                  >
                    <option value="" disabled>
                      Pick a pay period…
                    </option>
                    {periodOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                        {o.alreadyRunning ? " — already under way" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="block text-xs font-medium text-fg-muted mb-1.5">
                  Note <span className="font-normal">(optional)</span>
                </span>
                <input
                  name="note"
                  type="text"
                  maxLength={500}
                  defaultValue={values.note}
                  placeholder="What this stipend covers"
                  className="w-full rounded-lg border border-line bg-surface-2 h-9 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
                />
              </label>

              {/* The "does not change the past" preview, stated plainly and
                  always — it is the answer to the question this card most
                  invites, and it is true by construction. */}
              <p className="text-xs text-fg-muted leading-relaxed">
                Saving this <strong>does not change any past pay period</strong>
                . Earlier periods keep the amount that was in effect when they
                were worked — the old amount is closed off and the new one takes
                over from the date you pick.
              </p>

              <div className="flex items-center justify-end">
                <button
                  type="submit"
                  disabled={pending}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
                >
                  {pending
                    ? "Saving…"
                    : onStipend
                      ? "Change amount"
                      : "Put on a stipend"}
                </button>
              </div>
            </form>

            {/* ── End ──────────────────────────────────────────────────── */}
            {onStipend ? (
              <form
                action={endAction}
                key={endState.ok ? `end-ok-${versions.length}` : "end-decision"}
                className="space-y-3 border-t border-line pt-4"
              >
                <input type="hidden" name="coachId" defaultValue={coachId} />

                {endPlainError ? (
                  <div
                    role="alert"
                    className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
                  >
                    {endState.error.message}
                  </div>
                ) : null}

                {endNeedsConfirm ? (
                  <div
                    role="alert"
                    className="rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-xs text-fg space-y-2"
                  >
                    <p className="font-semibold">
                      This removes pay from a period already under way.
                    </p>
                    <p className="leading-relaxed">{endState.message}</p>
                    <div className="pt-1">
                      <button
                        type="submit"
                        name="confirmBackdate"
                        value="true"
                        disabled={endPending}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-warning/50 bg-warning/20 hover:bg-warning/30 h-8 px-3 text-xs font-medium text-fg disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 transition-colors"
                      >
                        {endPending ? "Ending…" : "Yes — end it anyway"}
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-end justify-between gap-3">
                  <label className="block">
                    <span className="block text-xs font-medium text-fg-muted mb-1.5">
                      Take {who} off the stipend from
                    </span>
                    <select
                      name="effectiveTo"
                      required
                      defaultValue=""
                      className="rounded-lg border border-line bg-surface-2 h-9 px-3 text-sm text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
                    >
                      <option value="" disabled>
                        Pick a pay period…
                      </option>
                      {periodOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                          {o.alreadyRunning ? " — already under way" : ""}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="submit"
                    disabled={endPending}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 hover:bg-surface-3 h-9 px-4 text-sm font-medium text-fg disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
                  >
                    {endPending ? "Ending…" : "End stipend"}
                  </button>
                </div>

                <p className="text-xs text-fg-muted leading-relaxed">
                  Stipends already earned stay earned. Ending only stops future
                  pay periods from paying one.
                </p>
              </form>
            ) : null}
          </>
        )}

        {/* ── History ──────────────────────────────────────────────────── */}
        {versions.length > 0 ? (
          <div className="border-t border-line pt-4">
            <h4 className="text-sm font-semibold text-fg mb-2">History</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th className="py-1.5 pr-4 font-medium">Amount</th>
                    <th className="py-1.5 pr-4 font-medium">From</th>
                    <th className="py-1.5 pr-4 font-medium">Until</th>
                    <th className="py-1.5 font-medium">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id} className="border-t border-line/60">
                      <td className="py-2 pr-4 tabular-nums text-fg">
                        {v.amountLabel}
                        {v.isCurrent ? (
                          <span className="ml-2 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-medium text-gold align-middle">
                            current
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-4 text-fg-muted">{v.fromLabel}</td>
                      <td className="py-2 pr-4 text-fg-muted">
                        {v.toLabel ?? "—"}
                      </td>
                      <td className="py-2 text-fg-muted">{v.note ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
