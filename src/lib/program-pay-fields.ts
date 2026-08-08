// SPEC rate-effective-dating §7 — THE ONE SOURCE OF TRUTH for the two pay
// amounts in the program create/edit form.
//
// ── The P0 this module exists to make impossible ─────────────────────────
// The program dialog used to render the hourly amount and the per-session
// amount as UNCONTROLLED inputs (`defaultValue` + `onChange`) inside the two
// arms of a `{perSession ? … : …}` ternary, while a `useRef` mirrored what had
// been typed so the inline re-price preview could price it.
//
// Toggling the pay mode swapped the ternary arms, so React UNMOUNTED the input
// and mounted a fresh one, re-seeded from `defaults` — and the ref kept the
// typed value. From that moment the DOM (what `FormData` submits, and what the
// engine actually writes) and the ref (what the preview priced) disagreed. The
// confirm screen could quote a re-price that never happened; worse, toggling
// mode on a per-session program submitted an EMPTY hourly field, nulling both
// rate columns and re-pricing every in-window log to $0 — with the decrease
// confirmation already ticked, because the admin ticked it for a different
// number.
//
// ── The rule that replaces it ────────────────────────────────────────────
// ONE object holds `payMode` + both amounts. The inputs render its values
// (controlled), BOTH are always mounted (the inactive one's CONTAINER carries
// the HTML `hidden` attribute so the input stays in the DOM and still
// submits), and the preview prices the SAME object. There is no mirror to
// drift, because there is nothing to mirror — the pattern already proven in
// src/app/admin/coaches/[id]/_components/program-rate-overrides-card.tsx.
//
// ── Why a plain module and not just component state ──────────────────────
// The unit suite runs in `environment: "node"` with no jsdom and no
// testing-library (vitest.config.ts), the same constraint that put the §6
// copy in src/lib/rate-reprice-copy.ts. State transitions living inside a
// React component are untestable here; living here, the type → toggle →
// toggle sequence that caused the P0 is pinned by a test, and so is the
// invariant that what the form SUBMITS and what the preview PRICES are two
// readings of one value.

export type ProgramPayMode = "hourly" | "per_session";

/** Every pay-relevant value the program form carries, as typed. */
export type ProgramPayFieldValues = {
  payMode: ProgramPayMode;
  /** Pay rate per HOUR, as dollars (e.g. "44.00"). "" = no rate. */
  rateDollars: string;
  /** Flat pay per logged session, as dollars (e.g. "100.00"). "" = not set. */
  perSessionDollars: string;
};

/** The two amount fields, by the `name` each submits under. */
export type ProgramPayAmountField = "rateDollars" | "perSessionDollars";

/** The seed for a fresh form — a defensive copy, never the caller's object. */
export function initialProgramPayFields(
  defaults: ProgramPayFieldValues,
): ProgramPayFieldValues {
  return {
    payMode: defaults.payMode,
    rateDollars: defaults.rateDollars,
    perSessionDollars: defaults.perSessionDollars,
  };
}

/**
 * Switch how the program pays.
 *
 * 🔴 It changes the MODE AND NOTHING ELSE. It never clears an amount, never
 * copies one amount into the other, and never re-reads `defaults`. That is the
 * whole fix: the amounts survive a toggle because nothing here touches them,
 * and the inputs survive it because both are always rendered.
 *
 * Which amount actually reaches the database is decided ONCE, server-side, by
 * `buildProgramInput` in form-actions.ts — it nulls whichever column the
 * chosen mode does not use. Deciding it here as well would be a second
 * opinion on a money question, which is exactly what this feature exists to
 * remove.
 */
export function setProgramPayMode(
  values: ProgramPayFieldValues,
  payMode: ProgramPayMode,
): ProgramPayFieldValues {
  return { ...values, payMode };
}

/** Record a keystroke in one amount field. The other is untouched. */
export function setProgramPayAmount(
  values: ProgramPayFieldValues,
  field: ProgramPayAmountField,
  value: string,
): ProgramPayFieldValues {
  return { ...values, [field]: value };
}

/**
 * EXACTLY the name/value pairs the form posts — all three, always, in both
 * modes. `ProgramFields` renders these three names with these three values,
 * so this is not a parallel description of the payload: it IS the payload.
 *
 * Both amounts are always sent because `buildProgramInput` relies on it to
 * CLEAR the amount the chosen mode no longer uses. A program flipped
 * hourly → per-session → hourly must not keep a stale flat fee, which would
 * silently win in `workPayForLog`.
 */
export function programPayFieldEntries(
  values: ProgramPayFieldValues,
): ReadonlyArray<readonly [string, string]> {
  return [
    ["payMode", values.payMode],
    ["rateDollars", values.rateDollars],
    ["perSessionDollars", values.perSessionDollars],
  ];
}

/** The submitted payload as a real `FormData` — used by the regression test. */
export function toProgramPayFormData(values: ProgramPayFieldValues): FormData {
  const fd = new FormData();
  for (const [name, value] of programPayFieldEntries(values)) {
    fd.append(name, value);
  }
  return fd;
}

/**
 * Changes whenever the candidate rate the inline preview would send changes.
 * Derived from the SAME object the inputs render, so a stale preview next to
 * a changed rate is not a state the dialog can be in.
 */
export function programPayCandidateKey(values: ProgramPayFieldValues): string {
  return `${values.payMode}|${values.rateDollars}|${values.perSessionDollars}`;
}
