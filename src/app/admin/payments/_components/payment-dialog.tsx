"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  recordPaymentFormAction,
  updatePaymentFormAction,
} from "../form-actions";
import type { CoachOption } from "./payments-client";
import { DateInput } from "@/app/_components/date-input";
import { PAYMENT_METHODS } from "@/lib/schemas/payment";
import {
  INITIAL_ACTION_STATE,
  endOfLastPfaMonth,
  paymentFormFields,
  paymentFormMountKey,
  paymentFormSeed,
  type PaymentInitialValues,
} from "./payment-dialog.model";

export type { PaymentInitialValues };

// Methods shown in the dropdown for NEW payments. Venmo dropped 2026-05-25
// (business Venmo charges incoming-payment fees) but kept in the enum so
// any historical "venmo" rows still render. If editing a legacy venmo row,
// the value displays via the existing initial.method path even though it
// isn't in this list.
const SELECTABLE_METHODS = PAYMENT_METHODS.filter((m) => m !== "venmo");

// Native <dialog> form for recording or editing a coach payment.
//
// ── TWO COMPONENTS, AND THE SPLIT IS THE BUG FIX ─────────────────────────────
// `PaymentDialog` owns the <dialog> ELEMENT and nothing else. `PaymentForm`
// owns every piece of form state — `useActionState` included — and is
// CONDITIONALLY RENDERED, keyed by `paymentFormMountKey`. So:
//
//   · closing the dialog UNMOUNTS the form, which is what discards a failed
//     save's state. Not an effect that resets it — the state has nowhere to live.
//   · pointing the dialog at a different payment REMOUNTS the form, because the
//     key carries the payment's id.
//
// 🔴 That is the fix for a cross-record write on the money ledger: a validation
// error on payment A used to survive a close and re-render A's coach, direction,
// paid date, coverage date, reference and note under payment B's hidden `id`,
// so saving wrote A's data onto B. The full incident, and why this shape makes
// it unrepresentable rather than unlikely, is documented in
// `payment-dialog.model.ts` — read that file before changing this one.
//
// ── EVERY FIELD IS CONTROLLED, AND THE <form> HAS NO `key` ───────────────────
// The form used to re-key itself on the action state so its UNCONTROLLED inputs
// (amount, reference, note) would re-seed from `defaults` on an error. That is
// the 0054 P0's exact shape — an uncontrolled MONEY input in a form that
// remounts, where the preview quoted one number and the save wrote another
// (SPEC §12.4) — and it mixed badly with the controlled fields: a parent
// re-render could reset the controlled half while the uncontrolled half kept
// typed text, and Save wrote one but not the other. Now there is one state
// object, one source of truth, and no remount on state change at all.
//
// Preserved from the original: auto-close on success via the wasPending ref
// trick, and the native <dialog> close event routed back through React state so
// Esc and backdrop clicks flow through `onClose`.

export function PaymentDialog({
  open,
  mode,
  onClose,
  coachOptions,
  initial,
  prefillCoachId,
}: {
  open: boolean;
  mode: "create" | "edit";
  onClose: () => void;
  coachOptions: CoachOption[];
  initial?: PaymentInitialValues;
  prefillCoachId?: string | null;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  // null while closed → the form subtree is not rendered → its state is gone.
  const formKey = paymentFormMountKey({ open, mode, initialId: initial?.id });

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      {formKey === null ? null : (
        <PaymentForm
          key={formKey}
          mode={mode}
          onClose={onClose}
          coachOptions={coachOptions}
          initial={initial}
          prefillCoachId={prefillCoachId}
        />
      )}
    </dialog>
  );
}

function PaymentForm({
  mode,
  onClose,
  coachOptions,
  initial,
  prefillCoachId,
}: {
  mode: "create" | "edit";
  onClose: () => void;
  coachOptions: CoachOption[];
  initial?: PaymentInitialValues;
  prefillCoachId?: string | null;
}) {
  const action =
    mode === "edit" ? updatePaymentFormAction : recordPaymentFormAction;
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_ACTION_STATE,
  );

  // Captured ONCE, on mount, from the payment this form is for. Lazy init, not
  // a memo: a memo's deps would include `initial`, which is a fresh object
  // literal on every parent render, so it would re-derive (and reset the fields
  // under the user) on any unrelated re-render of the page.
  //
  // `endOfLastMonth` is captured in the SAME initializer as the seed, so the
  // default the seed wrote and the value the chip's "is this preset active"
  // comparison reads are one number, not two reads of the clock that could
  // straddle a month boundary.
  const [{ seed, endOfLastMonth }] = useState(() => {
    const endOfLastMonth = endOfLastPfaMonth();
    return {
      endOfLastMonth,
      seed: paymentFormSeed({ mode, initial, prefillCoachId, endOfLastMonth }),
    };
  });

  // What to render: the seed, or — after a failed save — what was typed. Bounded
  // to THIS payment, because `state` cannot outlive this mount (SPEC §12.3).
  const [values, setValues] = useState(() =>
    paymentFormFields({ seed, state }),
  );

  // ⚠️ The reset is triggered off `state`'s IDENTITY, not off the derived fields'.
  // `paymentFormFields` builds a fresh object on every call, so comparing THAT
  // would be true on every render and would re-seed the form — wiping what is
  // being typed — continuously. `useActionState`'s state changes identity only
  // when an action RESULT comes back, which is exactly (and only) when the
  // §12.3 error echo should move a field.
  const [prevState, setPrevState] = useState(state);
  if (state !== prevState) {
    setPrevState(state);
    setValues(paymentFormFields({ seed, state }));
  }

  const set = <K extends keyof typeof values>(
    key: K,
    next: (typeof values)[K],
  ) => setValues((prev) => ({ ...prev, [key]: next }));

  // Bumped by a coverage CHIP press, and by nothing else — see the comment on
  // the coverage `DateInput`'s `key` below for why a chip has to be able to
  // override text the field could not resolve.
  const [coverageEpoch, setCoverageEpoch] = useState(0);
  const setCoverage = (iso: string) => {
    set("coversThroughDate", iso);
    setCoverageEpoch((n) => n + 1);
  };

  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok) {
      onClose();
    }
    wasPending.current = pending;
  }, [pending, state, onClose]);

  return (
    <form action={formAction} className="space-y-5 p-6">
      {/* 🔴 From the SEED, never from live props. The bleed was exactly a
          mismatch between the id in this input and the values above it. */}
      {seed.paymentId ? (
        <input type="hidden" name="id" value={seed.paymentId} />
      ) : null}

      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
            {mode === "edit" ? "Edit" : "Record"}
          </p>
          <h2 className="text-xl font-semibold tracking-tight mt-0.5">
            Coach payment
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center h-8 w-8 -mr-1 -mt-1 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {!state.ok ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      <div className="space-y-3">
        <Field label="Coach">
          <select
            name="coachId"
            required
            value={values.coachId}
            onChange={(e) => set("coachId", e.target.value)}
            className={selectStyles}
          >
            <option value="" disabled>
              Choose a coach…
            </option>
            {coachOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name ?? c.email}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Direction" hint="Which way did the money move?">
          <input type="hidden" name="direction" value={values.direction} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <DirectionOption
              checked={values.direction === "coach_to_pfa"}
              onSelect={() => set("direction", "coach_to_pfa")}
              title="Coach paid PFA"
              subtitle="Cage rental"
            />
            <DirectionOption
              checked={values.direction === "pfa_to_coach"}
              onSelect={() => set("direction", "pfa_to_coach")}
              title="PFA paid coach"
              subtitle="Work hours"
            />
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" hint="In dollars (e.g. 150 or 150.00).">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle text-sm">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                name="amountDollars"
                required
                value={values.amountDollars}
                onChange={(e) => set("amountDollars", e.target.value)}
                placeholder="0.00"
                className={`${inputStyles} pl-7`}
              />
            </div>
          </Field>

          <Field label="Date">
            {/* `rawName` is what lets the server tell "left blank" from
                "typed something that isn't a date" — see the Covers-through
                field below, where the difference is the bug. */}
            <DateInput
              name="paidAtDate"
              rawName="paidAtRaw"
              required
              value={values.paidAtDate}
              onChange={(iso) => set("paidAtDate", iso)}
              className={inputStyles}
            />
          </Field>
        </div>

        <Field
          label="Covers through"
          optional
          hint="The period this money settles — not when it arrived. July rent Zelled on Aug 7 covers through Jul 31."
        >
          {/* 🔴 `rawName` is load-bearing on THIS field. `maskedToIso` returns ""
              for anything not a fully valid date — an impossible one like
              02/31/2026 and a half-typed one like 07/31/202 alike — and blank is
              LEGAL here, so the boundary cannot use emptiness to detect a typo
              the way `paidAtDate`'s `if (!paidAtDate) throw` does. Without the
              raw text, a typo and a deliberate "Not stated" are indistinguishable
              on the server, and the typo silently CLEARS a previously set
              coverage date — dropping the payment out of its period's statement
              into "no period stated", the precise failure this feature exists to
              prevent. */}
          {/* ⚠️ `key={coverageEpoch}` is what makes a CHIP win over unresolved
              typed text. `DateInput` deliberately refuses to adopt a parent value
              of "" while its own text has not resolved to an ISO — otherwise
              typing "07/3" would be clobbered mid-keystroke, since a partial
              reports "" upward. But that same guard meant a field reading
              "02/31/2026" (ISO "") ignored a "Not stated" tap: the state was
              already "", so nothing changed, and the raw text — now REJECTED by
              the boundary — stayed put. The user would be told the date is
              invalid and the one-click escape would appear to do nothing.
              Bumping the key on a chip press remounts the input, which re-seeds
              it from `values.coversThroughDate`.
              This is NOT the 0054 remount hazard (SPEC §12.4): that was an
              UNCONTROLLED input re-seeding from a stale `defaults` while a ref
              mirror held a different value. This input is controlled from the one
              state object, so a remount can only reproduce that same value —
              hidden ISO, raw text and controlled state all land on it together.
              Chips are separate buttons, so no focused field loses focus. */}
          <DateInput
            key={`coverage-${coverageEpoch}`}
            name="coversThroughDate"
            rawName="coversThroughRaw"
            value={values.coversThroughDate}
            onChange={(iso) => set("coversThroughDate", iso)}
            className={inputStyles}
          />
          {/* Same chip idiom as RepeatsUntilPresets (schedule): presets over
              the SAME field, one emitted value shape either way. "Not stated"
              has to be reachable in one click — clearing is the user-facing
              half of the SPEC §12.1 bug. */}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <CoverageChip
              label="End of last month"
              on={values.coversThroughDate === endOfLastMonth}
              onSelect={() => setCoverage(endOfLastMonth)}
            />
            <CoverageChip
              label="Same as paid date"
              // Reads the CURRENT paid-date state, so retyping the paid date
              // and then tapping this lands on the new value.
              on={
                values.coversThroughDate !== "" &&
                values.coversThroughDate === values.paidAtDate
              }
              onSelect={() => setCoverage(values.paidAtDate)}
            />
            <CoverageChip
              label="Not stated"
              on={values.coversThroughDate === ""}
              onSelect={() => setCoverage("")}
            />
          </div>
        </Field>

        <Field label="Method">
          <select
            name="method"
            required
            value={values.method}
            onChange={(e) => set("method", e.target.value)}
            className={selectStyles}
          >
            {SELECTABLE_METHODS.map((m) => (
              <option key={m} value={m}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </option>
            ))}
            {/* Preserve a legacy venmo selection when editing an old row */}
            {values.method === "venmo" ? (
              <option value="venmo">Venmo (legacy)</option>
            ) : null}
          </select>
        </Field>

        <Field
          label="Reference"
          optional
          hint="Zelle confirmation #, check #, etc."
        >
          <input
            type="text"
            name="reference"
            value={values.reference}
            onChange={(e) => set("reference", e.target.value)}
            maxLength={200}
            placeholder="Optional"
            className={inputStyles}
          />
        </Field>

        <Field label="Note" optional>
          <input
            type="text"
            name="note"
            value={values.note}
            onChange={(e) => set("note", e.target.value)}
            maxLength={500}
            placeholder="Optional context (e.g. May rentals settlement)"
            className={inputStyles}
          />
        </Field>
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
        >
          {pending ? "Saving…" : mode === "edit" ? "Save changes" : "Record"}
        </button>
      </div>
    </form>
  );
}

function Field({
  label,
  hint,
  optional,
  children,
}: {
  label: string;
  hint?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between mb-1.5">
        <span className="text-xs uppercase tracking-wider text-fg-muted">
          {label}
        </span>
        {optional ? (
          <span className="text-[10px] text-fg-subtle">optional</span>
        ) : null}
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

// A single direction radio rendered as a tappable card. Plain, explicit
// labels (part of QA2 #5 directional-wording): the title states who paid
// whom and the subtitle names which ledger it nets against.
function DirectionOption({
  checked,
  onSelect,
  title,
  subtitle,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2.5 text-sm transition-colors ${
        checked
          ? "border-gold/60 bg-gold/10 ring-1 ring-inset ring-gold/40"
          : "border-line bg-page hover:border-line-strong"
      }`}
    >
      <input
        type="radio"
        name="directionRadio"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 accent-gold"
      />
      <span className="flex flex-col leading-tight">
        <span className="font-medium text-fg">{title}</span>
        <span className="text-[11px] text-fg-subtle">{subtitle}</span>
      </span>
    </label>
  );
}

// One coverage preset. Borrows RepeatsUntilPresets' chip styling verbatim
// (src/app/admin/schedule/_components/repeats-until-presets.tsx) so the two
// preset controls in this app look like the same control.
//
// preventDefault matters: these buttons sit inside the <Field> <label>, and a
// click inside a label otherwise forwards to the labeled control (the DateInput)
// as its default action. Cancelling it keeps a chip tap from also poking the
// date field.
function CoverageChip({
  label,
  on,
  onSelect,
}: {
  label: string;
  on: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        onSelect();
      }}
      aria-pressed={on}
      className={[
        "inline-flex items-center justify-center h-8 px-2.5 rounded-md border text-xs font-medium select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40",
        on
          ? "bg-gold/10 border-gold/40 text-gold-strong"
          : "border-line text-fg-muted hover:text-fg hover:border-line-strong",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;
