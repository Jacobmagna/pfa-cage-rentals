// 🔴 STIPEND SPEC §2.13 — reading Mark's per-PROGRAM switch off the program
// form. This is the reader half of the ONLY write path to
// `programs.stipend_eligible` that exists in the product.
//
// ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────
// It would naturally live in admin/hour-log/programs/form-actions.ts beside
// buildProgramInput. It cannot: that file is "use server", so nothing in it is
// reachable from a unit test without going through an RPC boundary, and its
// helpers are not exported at all. Same constraint that put the pay-mode state
// machine in @/lib/program-pay-fields and the dollar parsers in
// @/lib/rate-input — a rule the form obeys but no test can see is a rule that
// silently stops being true.
//
// ── 🔴 WHY THE FORM SUBMITS A HIDDEN VALUE, NOT A BARE CHECKBOX ─────────
// An unchecked checkbox submits NOTHING. A bare one would therefore make
// "absent" mean two different things:
//
//   (a) the admin looked at the box and left it unticked  → write `false`
//   (b) this form never carried the control at all        → write NOTHING
//
// Those differ by a payroll change. Under (b) read as (a), any form posting to
// updateProgramFormAction — a future bulk edit, a rename-only dialog, a
// partial save — would silently switch a program's stipend coverage OFF, and
// every log on it would start paying hourly ON TOP of the coach's stipend.
// Nothing would report it: the save succeeds, the audit diff looks like a
// deliberate edit, and the double pay surfaces only on a statement.
//
// So the visible checkbox carries no `name` and submits nothing. A hidden
// input tracks it and ALWAYS submits an explicit "true" or "false" — exactly
// the pattern `payMode` already uses three fields above it in
// program-fields.tsx. Absent then unambiguously means (b), and this returns
// `undefined`: updateProgramSchema strips it as an absent optional and
// updateProgramInternal leaves the stored column alone.
//
// ⚠️ Same class of defect as the one that made the whole stipend feature
// inert: a money-bearing boolean a person is supposed to control must never be
// written by accident, in EITHER direction.

/** The hidden input's `name` — always submitted, never the checkbox's own. */
export const STIPEND_ELIGIBLE_FIELD = "stipendEligible";

/** The two values the hidden input carries. Constants so writer and reader cannot drift. */
export const STIPEND_ELIGIBLE_TRUE = "true";
export const STIPEND_ELIGIBLE_FALSE = "false";

/** What the hidden input should submit for a given checkbox state. */
export function stipendEligibleFormValue(checked: boolean): string {
  return checked ? STIPEND_ELIGIBLE_TRUE : STIPEND_ELIGIBLE_FALSE;
}

/**
 * Read the eligibility answer off a submitted program form.
 *
 * @returns `true` / `false` when the form carried the control, `undefined`
 *   when it did not — meaning "leave the stored column alone".
 *
 * ⚠️ An unrecognised string is `undefined`, not `false`. Only a hand-built
 *   payload can produce one, and refusing to write is the safe reading of a
 *   value we did not author.
 */
export function readStipendEligible(formData: FormData): boolean | undefined {
  const raw = formData.get(STIPEND_ELIGIBLE_FIELD)?.toString();
  if (raw === STIPEND_ELIGIBLE_TRUE) return true;
  if (raw === STIPEND_ELIGIBLE_FALSE) return false;
  return undefined;
}
