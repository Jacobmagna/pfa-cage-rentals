"use client";

// Shared form fields for create + edit program forms: name + how the program
// pays. The program-level session cap was removed — the cap is now a
// PER-ATHLETE enrollment cap set on the Roster assign flow, so the
// create/edit form no longer carries cap/capPeriod.
//
// 0052 — PAY MODE. A program pays either BY TIME (per-hour rate, the
// original and still the default) or PER SESSION (a flat fee for each logged
// session, regardless of how long it ran). Per-session previously existed
// only as a per-coach override, which is why a flat per-GAME fee had to be
// faked as an hourly rate — and then paid by game length.
//
// 🔴 THE AMOUNT INPUTS ARE CONTROLLED, AND BOTH ARE ALWAYS RENDERED.
// They used to be uncontrolled (`defaultValue` + `onChange`) inside the two
// arms of a `{perSession ? … : …}` ternary, with a `useRef` mirror feeding the
// inline re-price preview. Toggling the mode swapped the arms, React remounted
// the input and re-seeded it from `defaults`, and the ref kept what had been
// typed — so the DOM (what FormData submits, and what the engine writes) and
// the preview (what Mark confirms) could quote different numbers. On a
// per-session program a toggle could submit an EMPTY hourly field, null both
// rate columns and re-price every in-window log to $0.
//
// The fix is the pattern already proven in
// admin/coaches/[id]/_components/program-rate-overrides-card.tsx: BOTH fields
// always mounted with stable distinct keys, values CONTROLLED from one state
// object owned by the parent, and the inactive field's CONTAINER carrying the
// HTML `hidden` attribute so its <input> stays in the DOM and still submits.
// The state itself, and the transitions over it, live in
// @/lib/program-pay-fields so the type → toggle → toggle sequence is pinned by
// a unit test (this suite has no DOM — see vitest.config.ts).
//
// 🔴 STIPEND SPEC §2.13 — THE ELIGIBILITY CHECKBOX AT THE BOTTOM IS THE ONLY
// WRITE PATH TO `programs.stipend_eligible` IN THE PRODUCT. Without it the
// column has three readers and no writers, and the entire stipend feature
// ships inert: an admin can set a coach's stipend amount and no log is ever
// covered, because coverage requires BOTH facts. Its local `useState` is
// deliberately NOT folded into the pay-fields state machine above — that
// machine exists to stop two amount inputs drifting apart across a
// mode-swapping remount, and a single always-mounted checkbox has neither a
// mirror to drift nor an arm to swap.

import { useState } from "react";
import {
  STIPEND_ELIGIBLE_FIELD,
  stipendEligibleFormValue,
} from "@/lib/program-stipend-field";
import {
  initialProgramPayFields,
  setProgramPayAmount,
  setProgramPayMode,
  type ProgramPayAmountField,
  type ProgramPayFieldValues,
  type ProgramPayMode,
} from "@/lib/program-pay-fields";

export type ProgramFieldDefaults = ProgramPayFieldValues & {
  name: string;
  /** STIPEND SPEC §2.13 — seeds the eligibility checkbox. */
  stipendEligible: boolean;
};

/**
 * The single source of truth for the pay half of the form, owned by whichever
 * form is rendering it.
 *
 * It lives in the PARENT rather than inside `ProgramFields` for the same
 * reason `useRateEffectiveDate` does: the edit dialog needs these values to
 * price the inline preview (SPEC §7), and a child reporting them upward
 * through a callback would leave two copies of the same number — which is the
 * bug this whole change removes. One `useState`, read by the inputs and by the
 * preview.
 */
export type ProgramPayFieldsState = {
  values: ProgramPayFieldValues;
  setMode: (mode: ProgramPayMode) => void;
  setAmount: (field: ProgramPayAmountField, value: string) => void;
};

export function useProgramPayFields(
  defaults: ProgramPayFieldValues,
): ProgramPayFieldsState {
  const [values, setValues] = useState<ProgramPayFieldValues>(() =>
    initialProgramPayFields(defaults),
  );
  return {
    values,
    setMode: (mode) => setValues((v) => setProgramPayMode(v, mode)),
    setAmount: (field, value) =>
      setValues((v) => setProgramPayAmount(v, field, value)),
  };
}

export function ProgramFields({
  defaults,
  fields,
  rateAside = null,
  rateFooter = null,
}: {
  defaults: ProgramFieldDefaults;
  /**
   * The live pay values. Created by `useProgramPayFields` in the parent so the
   * SAME object drives the DOM and the inline preview.
   */
  fields: ProgramPayFieldsState;
  /**
   * Rendered beside the pay-rate LABEL. The edit dialog puts the SPEC §7
   * rate-history 3-dot menu here; create mode passes nothing (a program that
   * does not exist yet has no history).
   */
  rateAside?: React.ReactNode;
  /**
   * Rendered UNDER the pay-rate input. The edit dialog puts the SPEC §7
   * effective-date control here — the retro instruction belongs at the moment
   * the rate is set, not on a separate screen.
   *
   * Create mode passes nothing, deliberately: `createProgramSchema` has no
   * `defaultRateEffectiveFrom`, because a program created one statement ago
   * has no logged hours and a retro window on it could only be a lie.
   */
  rateFooter?: React.ReactNode;
}) {
  const { values, setMode, setAmount } = fields;
  const perSession = values.payMode === "per_session";

  return (
    <div className="space-y-4">
      <Field label="Name">
        <input
          type="text"
          name="name"
          required
          maxLength={200}
          defaultValue={defaults.name}
          placeholder="e.g. Elite Hitting"
          className={inputStyles}
        />
      </Field>

      <Field label="How this program pays">
        {/* The submitted value: a hidden input tracks the toggle so the form
            posts payMode without needing a native select. */}
        <input type="hidden" name="payMode" value={values.payMode} readOnly />
        <div className="flex gap-2" role="group" aria-label="How this program pays">
          <ModeButton
            active={!perSession}
            onClick={() => setMode("hourly")}
            label="Pay by time"
            title="By time"
            hint="Paid per hour logged"
          />
          <ModeButton
            active={perSession}
            onClick={() => setMode("per_session")}
            label="Pay per session"
            title="Per session"
            hint="Flat fee each time it's logged"
          />
        </div>
      </Field>

      {/* The pay-amount block is a <div> rather than a wrapping <label> so the
          rate-history menu can sit BESIDE the label without a click on it
          being forwarded to the input. Both amount inputs carry an explicit
          aria-label, so nothing loses its accessible name.

          ⚠️ An amount field's accessible name must not CONTAIN a mode
          button's, either. The per-session AMOUNT field used to be called
          "Pay per session" — identical to the per-session MODE TOGGLE above —
          a real screen-reader ambiguity, and a Playwright strict-mode
          violation that forced the live-QA harness onto a name-attribute
          selector. "Pay per session amount" would still collide, because
          getByLabel matches on substring by default; "Amount paid per session"
          does not contain "Pay per session", so each control is reachable by
          its own name. */}
      <div>
        {/* ── HOURLY. Always in the DOM; the CONTAINER is what hides. ── */}
        <div hidden={perSession}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="block text-xs uppercase tracking-wider text-fg-muted">
              Pay rate (per hour)
            </span>
            {!perSession ? rateAside : null}
          </div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
              $
            </span>
            <input
              key="rateDollars"
              type="text"
              inputMode="decimal"
              name="rateDollars"
              value={values.rateDollars}
              onChange={(e) => setAmount("rateDollars", e.target.value)}
              placeholder="Optional — e.g. 44.00"
              aria-label="Pay rate per hour"
              className={`${inputStyles} pl-7`}
            />
          </div>
        </div>

        {/* ── PER SESSION. `required` would block submit while hidden, so the
            cross-field rule stays where it already is: updateProgramSchema /
            createProgramSchema refuse a per-session program with no amount,
            and the inline preview refuses to price one. ── */}
        <div hidden={!perSession}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="block text-xs uppercase tracking-wider text-fg-muted">
              Pay per session
            </span>
            {perSession ? rateAside : null}
          </div>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-fg-subtle">
              $
            </span>
            <input
              key="perSessionDollars"
              type="text"
              inputMode="decimal"
              name="perSessionDollars"
              value={values.perSessionDollars}
              onChange={(e) => setAmount("perSessionDollars", e.target.value)}
              placeholder="e.g. 100.00"
              aria-label="Amount paid per session"
              className={`${inputStyles} pl-7`}
            />
          </div>
        </div>

        {rateFooter}
      </div>

      {perSession ? (
        <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-fg-muted">
          Each logged session pays this flat amount, no matter how long it
          ran — a 2-hour game and a 4-hour game both pay the same.
          <br />
          <span className="text-fg">
            Heads up: a coach with their own rate set for this program keeps
            that rate. Clear their override to put them on the flat fee.
          </span>
        </p>
      ) : null}

      <StipendEligibleField defaultChecked={defaults.stipendEligible} />
    </div>
  );
}

/**
 * 🔴 STIPEND SPEC §2.13 — Mark's per-PROGRAM switch, and the only control in
 * the app that writes `programs.stipend_eligible`.
 *
 * ── WHY THE COPY SAYS WHAT IT SAYS ──────────────────────────────────────
 * A log is covered iff its program is eligible AND its coach has a stipend
 * amount (`resolveStipendCovered`). Ticking this box on its own changes
 * nobody's pay, and the label must not imply otherwise — "this work pays $0"
 * would be a straightforward lie to every coach who is not on a stipend. The
 * sentence therefore names both halves of the condition.
 *
 * The note also states that already-logged hours do not move, because they
 * genuinely do not: coverage is stamped on each log at write time and never
 * recomputed (SPEC §3.3). An admin who expects a retro here and does not get
 * one would reasonably conclude the feature is broken.
 *
 * ── 🔴 WHY THE CHECKBOX HAS NO `name` ───────────────────────────────────
 * An unchecked checkbox submits nothing, which would make "absent" mean both
 * "unticked" and "this form has no eligibility control" — two readings that
 * differ by a payroll change. So the box is a control only, and the hidden
 * input beside it always submits an explicit "true"/"false". That is the
 * pattern `payMode` already uses in this same component. The reasoning in
 * full, and the reader, are in @/lib/program-stipend-field.
 */
function StipendEligibleField({ defaultChecked }: { defaultChecked: boolean }) {
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <div className="border-t border-line pt-4">
      {/* 🔴 The submitted value. ALWAYS present, so its absence in a payload
          means "that form did not ask the question" and never "the answer is
          no". Read by readStipendEligible. */}
      <input
        type="hidden"
        name={STIPEND_ELIGIBLE_FIELD}
        value={stipendEligibleFormValue(checked)}
        readOnly
      />
      <label className="flex cursor-pointer items-start gap-2.5">
        {/* No `name` — see the hidden input above. This is the control; that
            is the value.

            ⚠️ The explicit aria-label is NOT decoration. Without it the
            accessible name is the wrapping <label>'s whole text content —
            the heading AND the two-sentence explanation concatenated — which
            reads terribly in a screen reader and is unstable to target. Same
            defect the two amount inputs above carry their own aria-labels to
            avoid, found the same way: by reading the rendered page's
            accessibility tree rather than trusting the markup. It is also
            chosen not to CONTAIN another control's name on this form
            ("Pay by time", "Pay per session", "Pay rate per hour", "Amount
            paid per session"), because getByLabel matches on substring. */}
        <input
          type="checkbox"
          aria-label="Stipend covers this work"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-line bg-page text-gold accent-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-fg">
            A coach&rsquo;s stipend covers this work
          </span>
          <span className="mt-0.5 block text-xs text-fg-muted">
            When a coach who is on a stipend logs this work, it pays $0 —
            their stipend already covers it. Coaches without a stipend are
            paid their normal rate.
          </span>
        </span>
      </label>

      {checked ? (
        <p className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-fg-muted">
          This only affects coaches who have a stipend amount set on their
          coach page. Everyone else keeps their normal rate for this work.
          <br />
          <span className="text-fg">
            Hours already logged don&rsquo;t change — this applies from here
            forward.
          </span>
        </p>
      ) : null}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  label,
  title,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  /**
   * The accessible name. Without it the name is the raw concatenation of the
   * title and hint spans ("By timePaid per hour logged"), which reads badly in
   * a screen reader and is unstable to target.
   */
  label: string;
  title: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      className={`flex-1 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 ${
        active
          ? "border-gold bg-gold/10 text-fg"
          : "border-line bg-page text-fg-muted hover:border-line-strong hover:text-fg"
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-fg-muted">{hint}</span>
    </button>
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

export const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 h-10 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
