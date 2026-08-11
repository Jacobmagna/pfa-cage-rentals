// 🔴 THE MOST IMPORTANT TEST IN THIS ROUND: a stale validation error writing one
// payment's values onto a DIFFERENT payment, on the money ledger.
//
// The defect and the fix are both described at length in `payment-dialog.model.ts`.
// This file reproduces the incident by SIMULATING REACT around that module, so
// the assertion is about component lifetime — which is where the bug lived —
// rather than about a helper in isolation.
//
// ── Why a simulator and not a rendered dialog ────────────────────────────────
// This suite runs in `environment: "node"` with no jsdom and no
// @testing-library, and `renderToStaticMarkup` cannot drive `useActionState`
// through a submit at all. So `ReactLifecycle` below models the three React
// facts the bug turned on, and nothing else:
//
//   1. A subtree rendered as `{key === null ? null : <Form key={key} …/>}` is
//      UNMOUNTED when the key is null, and REMOUNTED when the key changes.
//   2. A fresh mount re-initialises hooks: `useActionState` → its initial state,
//      `useState(() => seed)` → a seed captured from the props at that mount.
//   3. Re-rendering the SAME mount keeps both.
//
// The production component is a thin shell over exactly these calls, so if the
// simulator is right about React, the test is right about the dialog.
//
// ── How to see it RED (both edits together restore the shipped behaviour) ────
//   a. `payment-dialog.model.ts` → `paymentFormMountKey` returns a constant
//      (`"payment-dialog"`) regardless of `open` / `initialId`. That is what the
//      shipped dialog effectively did: `open` was a prop, not a mount gate, and
//      the `<form>`'s own `key` re-created DOM inputs without touching the
//      `useActionState` that lived on the component ABOVE the form.
//   b. `SEED_FOLLOWS_LIVE_PROPS` below → `true`. That is what the shipped
//      `defaults` memo did (deps included the `initial` object) and what the
//      shipped hidden `<input name="id" defaultValue={initial.id}>` did — read
//      live props while `state` stayed stale.

import { describe, expect, it } from "vitest";
import { parsePfaInput } from "@/lib/timezone";
import type { PaymentActionResult } from "../form-actions";
import {
  INITIAL_ACTION_STATE,
  paymentFormFields,
  paymentFormMountKey,
  paymentFormSeed,
  type PaymentFormValues,
  type PaymentInitialValues,
} from "./payment-dialog.model";

/**
 * The shipped dialog re-derived its `defaults` from the `initial` PROP on every
 * render and read the hidden `id` from live props too. The fix reads `initial`
 * exactly once, at mount. Flip to `true` together with the `paymentFormMountKey`
 * edit above to restore the incident and watch this file go red.
 */
const SEED_FOLLOWS_LIVE_PROPS = false;

const END_OF_LAST_MONTH = "2026-07-31";

type DialogProps = {
  open: boolean;
  mode: "create" | "edit";
  initial?: PaymentInitialValues;
  prefillCoachId?: string | null;
};

/** What the form would render and submit on this pass. */
type Rendered = { paymentId: string | null } & PaymentFormValues;

class ReactLifecycle {
  private mounted:
    | { key: string; seed: ReturnType<typeof paymentFormSeed>; state: PaymentActionResult }
    | null = null;

  /** One render pass of the parent. */
  render(props: DialogProps): void {
    const key = paymentFormMountKey({
      open: props.open,
      mode: props.mode,
      initialId: props.initial?.id,
    });
    if (key === null) {
      // The subtree is not rendered → React unmounts it → its hooks are gone.
      this.mounted = null;
      return;
    }
    if (!this.mounted || this.mounted.key !== key) {
      this.mounted = {
        key,
        seed: paymentFormSeed({ ...props, endOfLastMonth: END_OF_LAST_MONTH }),
        state: INITIAL_ACTION_STATE,
      };
      return;
    }
    if (SEED_FOLLOWS_LIVE_PROPS) {
      this.mounted.seed = paymentFormSeed({
        ...props,
        endOfLastMonth: END_OF_LAST_MONTH,
      });
    }
  }

  /** The result of a submit coming back through `useActionState`. */
  submitReturned(state: PaymentActionResult): void {
    if (!this.mounted) throw new Error("nothing is mounted to receive a result");
    this.mounted.state = state;
  }

  isMounted(): boolean {
    return this.mounted !== null;
  }

  mountKey(): string | null {
    return this.mounted?.key ?? null;
  }

  seedIdentity(): unknown {
    return this.mounted?.seed;
  }

  showsBanner(): boolean {
    return this.mounted !== null && !this.mounted.state.ok;
  }

  /** The hidden `id` and every field, read the way the component reads them. */
  rendered(): Rendered {
    if (!this.mounted) throw new Error("the dialog is closed — nothing renders");
    return {
      // 🔴 From the SEED, never from live props. One snapshot, one payment.
      paymentId: this.mounted.seed.paymentId,
      ...paymentFormFields({ seed: this.mounted.seed, state: this.mounted.state }),
    };
  }
}

/* ── The two payments from the incident ──────────────────────────────────── */

const PAYMENT_A: PaymentInitialValues = {
  id: "pay-A",
  coachId: "coach-alex",
  amountCents: 66_000,
  method: "zelle",
  direction: "coach_to_pfa",
  paidAt: parsePfaInput("2026-08-07", "00:00"),
  coversThrough: parsePfaInput("2026-07-31", "00:00"),
  reference: "July 2026",
  note: "July rentals settlement",
};

const PAYMENT_B: PaymentInitialValues = {
  id: "pay-B",
  coachId: "coach-lusk",
  amountCents: 180_000,
  method: "check",
  direction: "pfa_to_coach",
  paidAt: parsePfaInput("2026-08-09", "00:00"),
  coversThrough: parsePfaInput("2026-08-31", "00:00"),
  reference: "check 412",
  note: null,
};

const A_RENDERED: Rendered = {
  paymentId: "pay-A",
  coachId: "coach-alex",
  amountDollars: "660.00",
  method: "zelle",
  direction: "coach_to_pfa",
  paidAtDate: "2026-08-07",
  coversThroughDate: "2026-07-31",
  reference: "July 2026",
  note: "July rentals settlement",
};

const B_RENDERED: Rendered = {
  paymentId: "pay-B",
  coachId: "coach-lusk",
  amountDollars: "1800.00",
  method: "check",
  direction: "pfa_to_coach",
  paidAtDate: "2026-08-09",
  coversThroughDate: "2026-08-31",
  reference: "check 412",
  note: "",
};

/** The failure `dollarsToCents` produces on a fat-fingered amount, for A. */
function typoFailureFor(rendered: Rendered, badAmount: string): PaymentActionResult {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message: "Amount must be a dollar value like 150 or 150.00",
    },
    values: {
      coachId: rendered.coachId,
      amountDollars: badAmount,
      method: rendered.method,
      direction: rendered.direction,
      paidAtDate: rendered.paidAtDate,
      coversThroughDate: rendered.coversThroughDate,
      reference: rendered.reference,
      note: rendered.note,
    },
  };
}

/* ── §12.1 / §12.2 / §12.4 — the cross-record bleed. ─────────────────────── */

describe("🔴 a stale validation error must not write payment A's values onto payment B", () => {
  /** Steps 1–2 of the incident: fail on A, then walk away without fixing it. */
  function failOnAThenClose(): ReactLifecycle {
    const dialog = new ReactLifecycle();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_A });
    expect(dialog.rendered()).toEqual(A_RENDERED);

    dialog.submitReturned(typoFailureFor(A_RENDERED, "6600.00.00"));
    expect(dialog.showsBanner()).toBe(true);

    // Esc / Cancel / the X — all three land on the same `onClose()`.
    dialog.render({ open: false, mode: "edit", initial: PAYMENT_A });
    return dialog;
  }

  it("closing the dialog UNMOUNTS the state — there is nothing left to leak", () => {
    const dialog = failOnAThenClose();
    expect(dialog.isMounted()).toBe(false);
    expect(dialog.mountKey()).toBeNull();
  });

  it("editing B after abandoning a failed edit of A shows B — every field", () => {
    // THE INCIDENT. Before the fix every field here read A's data.
    const dialog = failOnAThenClose();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_B });
    expect(dialog.rendered()).toEqual(B_RENDERED);
  });

  it("and the hidden id and the values name the SAME payment", () => {
    // The half that made it a cross-record WRITE rather than a display glitch:
    // `buildInput` returns a COMPLETE object, so whatever is on screen is what
    // gets written to whatever id is in the form.
    const dialog = failOnAThenClose();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_B });
    const shown = dialog.rendered();
    expect(shown.paymentId).toBe("pay-B");
    expect(shown.direction).toBe("pfa_to_coach"); // §12.2's incident class
    expect(shown.coversThroughDate).toBe("2026-08-31"); // §12.1's field
    expect(shown.amountDollars).toBe("1800.00");
  });

  it("B's form carries NO stale error banner", () => {
    // The only clue the user ever got was a red banner reading "this form is
    // invalid" — about a payment they were no longer editing.
    const dialog = failOnAThenClose();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_B });
    expect(dialog.showsBanner()).toBe(false);
  });

  it("re-opening the SAME payment starts clean too", () => {
    // A stale banner and stale values for A are less harmful than B's, but they
    // still contradict what is stored — and "clean unless closed" is a rule with
    // an exception, which is the kind that rots.
    const dialog = failOnAThenClose();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_A });
    expect(dialog.showsBanner()).toBe(false);
    expect(dialog.rendered()).toEqual(A_RENDERED);
  });

  it("switching A → B WITHOUT closing also remounts", () => {
    // Reachable from the Reports payments timeline, which calls
    // `setEditing(row)` on an already-open dialog.
    const dialog = new ReactLifecycle();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_A });
    dialog.submitReturned(typoFailureFor(A_RENDERED, "66o.00"));

    dialog.render({ open: true, mode: "edit", initial: PAYMENT_B });
    expect(dialog.showsBanner()).toBe(false);
    expect(dialog.rendered()).toEqual(B_RENDERED);
  });

  it("a failed EDIT cannot bleed into a new RECORD either", () => {
    const dialog = failOnAThenClose();
    dialog.render({ open: true, mode: "create", prefillCoachId: "coach-lusk" });
    expect(dialog.rendered()).toEqual({
      paymentId: null,
      coachId: "coach-lusk",
      amountDollars: "",
      method: "zelle",
      direction: "coach_to_pfa",
      paidAtDate: expectedTodayPfa(),
      coversThroughDate: END_OF_LAST_MONTH,
      reference: "",
      note: "",
    });
    expect(dialog.showsBanner()).toBe(false);
  });

  it("a failed RECORD cannot bleed into an EDIT", () => {
    const dialog = new ReactLifecycle();
    dialog.render({ open: true, mode: "create" });
    dialog.submitReturned({
      ok: false,
      error: { code: "VALIDATION", message: "Choose a coach" },
      values: {
        coachId: "",
        amountDollars: "4,000",
        method: "cash",
        direction: "pfa_to_coach",
        paidAtDate: "2026-08-11",
        coversThroughDate: "",
        reference: "made up",
        note: "made up",
      },
    });
    dialog.render({ open: false, mode: "create" });
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_B });
    expect(dialog.rendered()).toEqual(B_RENDERED);
  });
});

/* ── SPEC §12.3 — the error echo still works, for the right payment. ─────── */

describe("the error echo (SPEC §12.3) survives the fix", () => {
  it("a failed save re-renders what was typed, including the coverage date", () => {
    const dialog = new ReactLifecycle();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_A });

    const typed = {
      coachId: "coach-alex",
      amountDollars: "66o.00", // the typo that failed
      method: "check", // …and three fields changed before submitting
      direction: "pfa_to_coach",
      paidAtDate: "2026-08-08",
      coversThroughDate: "2026-06-30",
      reference: "retyped ref",
      note: "retyped note",
    };
    dialog.submitReturned({
      ok: false,
      error: { code: "VALIDATION", message: "Amount must be a dollar value" },
      values: typed,
    });

    expect(dialog.rendered()).toEqual({ paymentId: "pay-A", ...typed });
    expect(dialog.showsBanner()).toBe(true);
  });

  it("the echo survives parent re-renders while the banner is up", () => {
    // Review finding M4: `initial` is a FRESH OBJECT LITERAL on every parent
    // render (`payments-client.tsx`, `payments-preview.tsx`), and the old memo's
    // deps included it — so any unrelated re-render in this window reset the
    // CONTROLLED fields to stored values while the UNCONTROLLED ones kept typed
    // text, and Save wrote one but not the other. Reachable by clicking Confirm
    // on a pending row and then immediately Edit a recent row.
    const dialog = new ReactLifecycle();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_A });
    const typed = { ...A_RENDERED, amountDollars: "66o.00", coversThroughDate: "" };
    dialog.submitReturned(typoFailureFor(typed, "66o.00"));

    // `confirmPayment` revalidates → the page re-renders → a NEW `initial`
    // literal with identical contents.
    dialog.render({ open: true, mode: "edit", initial: { ...PAYMENT_A } });

    const shown = dialog.rendered();
    expect(shown.amountDollars).toBe("66o.00");
    expect(shown.coversThroughDate).toBe(""); // did NOT snap back to Jul 31
    expect(shown.paymentId).toBe("pay-A");
  });

  it("an equal-but-fresh `initial` does NOT remount — typed text is safe", () => {
    // The fix's own failure mode if it keyed on the object instead of the id:
    // remounting on every parent render would discard what is being typed.
    const dialog = new ReactLifecycle();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_A });
    const seedBefore = dialog.seedIdentity();
    const keyBefore = dialog.mountKey();

    dialog.render({ open: true, mode: "edit", initial: { ...PAYMENT_A } });

    expect(dialog.mountKey()).toBe(keyBefore);
    expect(Object.is(dialog.seedIdentity(), seedBefore)).toBe(true);
  });
});

/* ── The reset TRIGGER. A trap this fix hit once during development. ─────── */

describe("paymentFormFields is not identity-stable — reset off `state`, never off it", () => {
  it("returns a FRESH object on every call, even for identical arguments", () => {
    // 🔴 Found while building the fix: the component first compared the DERIVED
    // fields object to decide whether to re-seed its controlled state. Because
    // this function constructs a new object each call, that comparison was true
    // on EVERY render — so the form re-seeded continuously and wiped whatever
    // was being typed. `useActionState`'s state changes identity only when an
    // action result comes back, so THAT is the trigger the component uses.
    const seed = paymentFormSeed({
      mode: "edit",
      initial: PAYMENT_A,
      endOfLastMonth: END_OF_LAST_MONTH,
    });
    const a = paymentFormFields({ seed, state: INITIAL_ACTION_STATE });
    const b = paymentFormFields({ seed, state: INITIAL_ACTION_STATE });
    expect(a).toEqual(b);
    expect(Object.is(a, b)).toBe(false);
  });

  it("never leaks the seed object itself, so a caller cannot mutate the snapshot", () => {
    const seed = paymentFormSeed({
      mode: "edit",
      initial: PAYMENT_A,
      endOfLastMonth: END_OF_LAST_MONTH,
    });
    const fields = paymentFormFields({ seed, state: INITIAL_ACTION_STATE });
    expect(Object.is(fields, seed)).toBe(false);
    expect("paymentId" in fields).toBe(false);
  });
});

/* ── Auto-close on success (SPEC §12.4's other half) ─────────────────────── */

describe("auto-close on success", () => {
  it("success closes, and the close IS the reset — one event, not two", () => {
    const dialog = new ReactLifecycle();
    dialog.render({ open: true, mode: "edit", initial: PAYMENT_A });
    dialog.submitReturned({ ok: true });
    // The success effect calls onClose(); the parent flips `open`.
    dialog.render({ open: false, mode: "edit", initial: PAYMENT_A });
    expect(dialog.isMounted()).toBe(false);
  });
});

/* ── The mount-key contract, asserted directly. ──────────────────────────── */

describe("paymentFormMountKey", () => {
  it("is null while closed, in either mode", () => {
    expect(paymentFormMountKey({ open: false, mode: "edit", initialId: "pay-A" })).toBeNull();
    expect(paymentFormMountKey({ open: false, mode: "create" })).toBeNull();
  });

  it("distinguishes two payments", () => {
    expect(paymentFormMountKey({ open: true, mode: "edit", initialId: "pay-A" })).not.toBe(
      paymentFormMountKey({ open: true, mode: "edit", initialId: "pay-B" }),
    );
  });

  it("distinguishes create from edit", () => {
    expect(paymentFormMountKey({ open: true, mode: "create" })).not.toBe(
      paymentFormMountKey({ open: true, mode: "edit", initialId: "pay-A" }),
    );
  });

  it("is a pure function of the id STRING, so it is stable per payment", () => {
    expect(paymentFormMountKey({ open: true, mode: "edit", initialId: "pay-A" })).toBe(
      paymentFormMountKey({ open: true, mode: "edit", initialId: "pay-A" }),
    );
  });
});

/* ── The seed, on its own. ───────────────────────────────────────────────── */

describe("paymentFormSeed", () => {
  it("carries the payment id WITH the values", () => {
    const seed = paymentFormSeed({
      mode: "edit",
      initial: PAYMENT_A,
      endOfLastMonth: END_OF_LAST_MONTH,
    });
    expect(seed.paymentId).toBe("pay-A");
    expect(seed.amountDollars).toBe("660.00");
  });

  it("renders an untagged row's coverage date as blank, never guessed from paidAt", () => {
    const seed = paymentFormSeed({
      mode: "edit",
      initial: { ...PAYMENT_A, coversThrough: null },
      endOfLastMonth: END_OF_LAST_MONTH,
    });
    expect(seed.coversThroughDate).toBe("");
    expect(seed.paidAtDate).toBe("2026-08-07");
  });

  it("a NEW payment has no id and defaults coverage to end-of-last-month", () => {
    const seed = paymentFormSeed({ mode: "create", endOfLastMonth: END_OF_LAST_MONTH });
    expect(seed.paymentId).toBeNull();
    expect(seed.coversThroughDate).toBe(END_OF_LAST_MONTH);
    expect(seed.amountDollars).toBe("");
  });

  it("edit mode with no `initial` falls back to the create seed, not a half row", () => {
    // Defensive but reachable: the Reports timeline renders `mode="edit"` with
    // `initial` undefined for the render before a row is picked.
    const seed = paymentFormSeed({ mode: "edit", endOfLastMonth: END_OF_LAST_MONTH });
    expect(seed.paymentId).toBeNull();
  });
});

/** Today, in PFA wall-clock — what a new payment's paid date defaults to. */
function expectedTodayPfa(): string {
  return paymentFormSeed({ mode: "create", endOfLastMonth: END_OF_LAST_MONTH })
    .paidAtDate;
}
