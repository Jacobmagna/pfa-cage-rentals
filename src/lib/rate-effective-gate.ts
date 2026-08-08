// SPEC rate-effective-dating §6/§7 — THE GATE. When is Save armed, what does
// the form submit, and when (if ever) does `confirmDecrease` ride along.
//
// ── Why this is a pure function and not `if`s inside the component ───────
// These three questions are the entire safety surface of Phase D2:
//
//   1. SPEC §7 — "choosing a past date reveals the preview BEFORE Save is
//      armed". So a past date with no preview yet must not be saveable.
//   2. SPEC §6 — a decrease needs a DELIBERATE second confirmation, and
//      `confirmDecrease` must be impossible to send without it.
//   3. SPEC §3 — a future date is never submitted.
//
// The unit suite here runs in `environment: "node"` with no DOM (see
// vitest.config.ts), so decisions living inside a React component are
// untestable. Living here, every branch is pinned by a test — including the
// ones that matter most, which are the ones that say "no".
//
// ── This is a SECOND gate, never the only one ────────────────────────────
// The form ALSO carries a `required` checkbox, so a browser refuses to submit
// while the decrease is unacknowledged. And the SERVER recomputes the diff
// from persisted state and throws RateRepriceDecreaseNotConfirmedError
// regardless of what any client sends. Three independent layers; this is the
// one that makes the refusal legible before Mark clicks.

import { isFutureEffectiveDate, type EffectiveMode } from "./rate-reprice-copy";
import { pfaWallClockToUtc } from "./timezone";

/** The lifecycle of the inline preview, as the control sees it. */
export type RatePreviewStatus =
  | "idle"
  | "loading"
  | "ready"
  | "no_candidate"
  | "error";

export type RateEffectiveGateInput = {
  mode: EffectiveMode;
  /** "YYYY-MM-DD" from the date input, or "". */
  dateValue: string;
  /** True when `dateValue` is past the PFA-time cap. */
  isFuture: boolean;
  status: RatePreviewStatus;
  /** True when the preview (client or server) contains ANY decrease. */
  hasDecrease: boolean;
  /** True only once the admin ticked the confirmation for THIS exact diff. */
  acknowledged: boolean;
};

export type RateEffectiveGateReason =
  | "ok"
  | "no_date"
  | "future_date"
  | "checking"
  | "check_failed"
  | "no_rate"
  | "decrease_unconfirmed";

export type RateEffectiveGate = {
  /** 🔴 The parent's Save button must be disabled while this is true. */
  blocked: boolean;
  /** Why — so the UI can say something specific instead of a dead button. */
  reason: RateEffectiveGateReason;
  /** What the hidden effective-date input submits. "" = going forward only. */
  submittedValue: string;
  /**
   * Whether this submit would carry `confirmDecrease: true`. Never true
   * without an acknowledged decrease, and never true when Save is blocked.
   */
  sendsConfirmDecrease: boolean;
};

/**
 * The whole decision, in one place.
 *
 * "Going forward only" is ALWAYS unblocked and ALWAYS submits "". That is not
 * a convenience — it is the escape hatch that guarantees this feature can
 * never trap an admin on a live payroll surface: whatever the preview is
 * doing, switching back gives exactly the behavior that shipped before
 * effective dating existed.
 */
export function decideRateEffectiveGate(
  input: RateEffectiveGateInput,
): RateEffectiveGate {
  if (input.mode === "forward") {
    return {
      blocked: false,
      reason: "ok",
      submittedValue: "",
      sendsConfirmDecrease: false,
    };
  }

  // A future date is never submitted, even if the picker's `max` was typed
  // straight past — the value falls back to "going forward only" rather than
  // becoming a date the schema and the engine would each reject anyway.
  if (input.isFuture || isFutureEffectiveDate(input.dateValue)) {
    return {
      blocked: true,
      reason: "future_date",
      submittedValue: "",
      sendsConfirmDecrease: false,
    };
  }

  const submittedValue = input.dateValue;

  if (input.dateValue === "") {
    return {
      blocked: true,
      reason: "no_date",
      submittedValue: "",
      sendsConfirmDecrease: false,
    };
  }

  // SPEC §7 — no number on screen yet, so there is nothing for Mark to have
  // confirmed. Applies to "still loading", "the check failed" and "you
  // haven't typed a rate yet" alike: all three mean the preview cannot vouch
  // for what the save would do.
  const notReady: Partial<Record<RatePreviewStatus, RateEffectiveGateReason>> = {
    loading: "checking",
    error: "check_failed",
    no_candidate: "no_rate",
    idle: "checking",
  };
  const notReadyReason = notReady[input.status];
  if (notReadyReason) {
    return {
      blocked: true,
      reason: notReadyReason,
      submittedValue,
      sendsConfirmDecrease: false,
    };
  }

  // 🔴 SPEC §6 — the hard stop.
  if (input.hasDecrease && !input.acknowledged) {
    return {
      blocked: true,
      reason: "decrease_unconfirmed",
      submittedValue,
      sendsConfirmDecrease: false,
    };
  }

  return {
    blocked: false,
    reason: "ok",
    submittedValue,
    // Only ever true here: past the future check, past the preview check, and
    // past an explicit acknowledgement of THIS diff.
    sendsConfirmDecrease: input.hasDecrease && input.acknowledged,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The server side of the same two fields
// ─────────────────────────────────────────────────────────────────────────

/**
 * "YYYY-MM-DD" → the UTC instant that starts that PFA calendar day, or null
 * for "going forward only".
 *
 * pfaWallClockToUtc, NOT `new Date(str)`: the bare string parses as UTC
 * midnight, which is 5pm the PREVIOUS day in California — so "back to Jun 19"
 * would quietly sweep in Jun 18's evening logs. The inline preview converts
 * with this same function, so the window quoted is the window saved.
 */
export function parseEffectiveFromInput(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error("Pick a valid date for when this rate starts.");
  }
  return pfaWallClockToUtc(trimmed, "00:00");
}

/**
 * 🔴 The one place `confirmDecrease` is read off a payload.
 *
 * Strict equality with the literal "true" — the string the required checkbox
 * carries as its `value`. An unticked checkbox is not in FormData at all, so
 * this sees `null` and returns false; and nothing else ("1", "on", "yes",
 * "TRUE") is ever mistaken for consent to lower someone's pay.
 */
export function parseConfirmDecrease(value: unknown): boolean {
  return value === "true";
}
