// The payment dialog's STATE MODEL, pulled out of the component so the one
// property that matters can be tested: what the form shows, and which payment
// it submits it to.
//
// ── 🔴 THE INCIDENT THIS FILE EXISTS TO MAKE IMPOSSIBLE ─────────────────────
// `PaymentDialog` is rendered by its parents with `open` as a PROP, not as a
// mount gate (`payments-client.tsx`, `payments-preview.tsx`), so closing it used
// to unmount nothing. `useActionState`'s failure state therefore SURVIVED a
// close, and the form seeded itself from `state.values` before it looked at the
// payment it was actually editing. The sequence:
//
//   1. Edit payment A ($660, coach_to_pfa, covers Jul 31). Fat-finger the amount
//      so `dollarsToCents` throws → state = { ok: false, values: snapshot(A) }.
//   2. Press Esc or Cancel instead of fixing it. `state` survives the close.
//   3. Edit payment B ($1,800, pfa_to_coach, covers Aug 31, ref "check 412").
//      Every field showed A's data — but the hidden `id` was read from live
//      props, so it was B's.
//   4. Fix the amount and Save. `buildInput` returns a COMPLETE object, so it
//      wrote A's coach, DIRECTION, paid date, coverage date, reference and note
//      onto payment B.
//
// A cross-record write on the money ledger, with a stale red banner reading
// "this form is invalid" as the only clue — not "these are another payment's
// numbers". Pre-existing for amount / direction / paidAt; the coverage field
// joined it, and the two new rejecting refinements plus `parsePfaInput`'s throw
// path raised the trigger rate.
//
// ── THE FIX IS STRUCTURAL, NOT DEFENSIVE ────────────────────────────────────
// There is no "reset the state on close" effect here, because an effect that
// clears state is a thing that can be forgotten, mis-ordered, or raced. Instead:
//
//   · `paymentFormMountKey` returns **null when closed**. The subtree that owns
//     `useActionState` is CONDITIONALLY RENDERED on it, so while the dialog is
//     shut the component holding the failure state DOES NOT EXIST. State cannot
//     leak across a close because there is nothing for it to live in.
//   · When open, the key carries the payment's id. Switching from A to B without
//     closing (reachable from the Reports timeline, which can call
//     `setEditing(otherRow)` on an open dialog) is a different key, so React
//     unmounts A's instance and mounts a fresh one for B.
//   · `PaymentFormSeed` carries `paymentId` ALONGSIDE the values, and the form
//     reads BOTH from that one snapshot. The id and the values are captured in
//     the same expression from the same `initial`, so "A's values, B's id" is not
//     a state to be avoided — it is unrepresentable.
//   · `paymentFormFields` is a pure function of `(seed, state)`. Nothing in the
//     mounted form re-reads `initial`, which closes the second symptom of the
//     same root cause (review finding M4): `initial` is a fresh object literal
//     on every parent render at both call sites, and a memo keyed on its
//     identity used to reset the controlled fields — coach, method, direction,
//     paid date, coverage date — back to stored values while the uncontrolled
//     ones kept typed text. Reachable by clicking Confirm on a pending row and
//     then immediately Edit: `confirmPayment`'s revalidation re-rendered the
//     parent, the coverage date snapped back, the new amount survived, and Save
//     wrote one but not the other.
//
// What is deliberately PRESERVED:
//   · SPEC §12.3's error echo — a failed save still re-renders what was typed,
//     for the payment being edited, because `state.values` wins over the seed
//     while the mount is alive.
//   · Auto-close-on-success — the success branch still calls `onClose()`, which
//     flips `open` false, which unmounts the subtree. The close and the reset
//     are now the SAME event rather than two that have to agree.

import { formatPfaDate, pfaMonthStart } from "@/lib/timezone";
import type { PaymentActionResult } from "../form-actions";
import type { PaymentDirection, PaymentMethod } from "@/lib/schemas/payment";

/** The stored payment a parent hands the dialog to edit. */
export type PaymentInitialValues = {
  id: string;
  coachId: string;
  amountCents: number;
  method: PaymentMethod;
  direction: PaymentDirection;
  paidAt: Date;
  coversThrough: Date | null;
  reference: string | null;
  note: string | null;
};

/** Every editable field, as the strings the form renders and submits. */
export type PaymentFormValues = {
  coachId: string;
  amountDollars: string;
  method: string;
  direction: string;
  paidAtDate: string;
  coversThroughDate: string;
  reference: string;
  note: string;
};

/**
 * The form's starting point, captured ONCE when the form mounts.
 *
 * 🔴 `paymentId` lives here, with the values, and not on the side. The bleed was
 * exactly a mismatch between the two — values from a stale action result, id
 * from live props — so binding them into one snapshot taken from one `initial`
 * is what makes that mismatch unrepresentable rather than merely unlikely.
 * `null` means "a new payment": there is no row to update.
 */
export type PaymentFormSeed = PaymentFormValues & { paymentId: string | null };

export const INITIAL_ACTION_STATE: PaymentActionResult = { ok: true };

/**
 * The mount identity of the state-owning form subtree, or **null when the
 * dialog is closed** — meaning "do not render it at all".
 *
 * Two jobs, both structural:
 *   · `null` on close is what discards `useActionState`. Not an effect.
 *   · the payment id in the key is what discards it when the dialog is pointed
 *     at a DIFFERENT payment without closing first.
 *
 * ⚠️ Derived from the payment's ID STRING, never from the `initial` object's
 * identity. `initial` is a fresh literal on every parent render, so keying on
 * the object would remount the form — and throw away what the user is typing —
 * on every unrelated re-render of the page. The id is stable; the object is not.
 */
export function paymentFormMountKey(args: {
  open: boolean;
  mode: "create" | "edit";
  initialId?: string;
}): string | null {
  if (!args.open) return null;
  return args.mode === "edit" ? `edit:${args.initialId ?? ""}` : "create";
}

/**
 * The values a freshly mounted form starts from.
 *
 * Called exactly once per mount, through `useState(() => …)`. Never a memo over
 * `initial`: see the M4 note in this file's header.
 */
export function paymentFormSeed(args: {
  mode: "create" | "edit";
  initial?: PaymentInitialValues;
  prefillCoachId?: string | null;
  /** `endOfLastPfaMonth()`, passed in so this stays pure and testable. */
  endOfLastMonth: string;
}): PaymentFormSeed {
  const { initial } = args;
  if (args.mode === "edit" && initial) {
    return {
      paymentId: initial.id,
      coachId: initial.coachId,
      amountDollars: centsToDollarsInput(initial.amountCents),
      method: initial.method,
      direction: initial.direction,
      paidAtDate: formatPfaDate(initial.paidAt),
      // An existing row's stated period, or "" for the rows that have none.
      // Never back-filled from paidAt — "no period stated" is the honest value
      // and the statement counts it in no period (SPEC §4).
      coversThroughDate: initial.coversThrough
        ? formatPfaDate(initial.coversThrough)
        : "",
      reference: initial.reference ?? "",
      note: initial.note ?? "",
    };
  }
  return {
    paymentId: null,
    coachId: args.prefillCoachId ?? "",
    amountDollars: "",
    method: "zelle",
    direction: "coach_to_pfa",
    paidAtDate: formatPfaDate(new Date()),
    // A NEW payment defaults to end-of-last-month: the overwhelmingly common
    // case is money arriving now for the month that just closed (Alex's $660 for
    // July, Zelled Aug 7). A default Mark can SEE and change is his choice —
    // which is why new entries get one and existing rows never do (SPEC §4, §6).
    coversThroughDate: args.endOfLastMonth,
    reference: "",
    note: "",
  };
}

/**
 * What the form renders: the seed, or — on a failed save — what was typed.
 *
 * SPEC §12.3's error echo, unchanged in behaviour and now bounded in scope. The
 * echo can only ever be the failure of a submit made from THIS mount, because
 * `state` dies with the mount, and the mount is one payment (or one new-payment
 * session). "The previous payment's snapshot" is no longer a value `state` can
 * hold while a different payment is on screen.
 *
 * Pure in `(seed, state)` — nothing here reads props. A parent re-render changes
 * neither argument, so it cannot move a field the user is editing.
 */
export function paymentFormFields(args: {
  seed: PaymentFormSeed;
  state: PaymentActionResult;
}): PaymentFormValues {
  const { seed, state } = args;
  if (!state.ok && state.values) return state.values;
  return {
    coachId: seed.coachId,
    amountDollars: seed.amountDollars,
    method: seed.method,
    direction: seed.direction,
    paidAtDate: seed.paidAtDate,
    coversThroughDate: seed.coversThroughDate,
    reference: seed.reference,
    note: seed.note,
  };
}

function centsToDollarsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Last day of the PFA calendar month BEFORE now, as ISO `YYYY-MM-DD` — the
 * default coverage period for a new payment.
 *
 * pfaMonthStart gives PFA-midnight on the 1st of the CURRENT month; one
 * millisecond earlier is the last instant of the PREVIOUS PFA month, so reading
 * its PFA date parts lands on 28/30/31 with no month-length table and no DST
 * arithmetic of our own. Deliberately not hand-rolled from `new Date()` getters,
 * which would answer in the viewer's timezone rather than the facility's.
 */
export function endOfLastPfaMonth(): string {
  return formatPfaDate(new Date(pfaMonthStart(new Date()).getTime() - 1));
}
