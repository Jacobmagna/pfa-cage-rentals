"use client";

// SPEC rate-effective-dating §7 — THE CONTROL Mark uses to backdate a rate,
// plus the §6 inline preview and the 🔴 decrease hard-stop.
//
// Shared verbatim by BOTH rate surfaces (the per-coach program override card
// and the program Work tab), because two copies of a payroll warning drift
// and the drift is invisible until someone reads the wrong number.
//
// ── Jacob's UI call: not always-visible clutter ──────────────────────────
// Collapsed to a single chip by default ("Going forward only"). The date
// picker, the preview and the warning only exist once Mark has said he wants
// to reach backwards. The per-coach card renders one of these PER PROGRAM ROW,
// so an always-open panel would bury the thing he actually came to edit.
//
// ── Why a hook + a dumb component, not one component ─────────────────────
// The parent's Save button has to be disarmed until the preview has arrived
// and (on a decrease) been acknowledged. Reporting that up through a callback
// would mean a child setting parent state from an effect — the pattern
// react-hooks/set-state-in-effect exists to stop, and the one this codebase
// keeps having to `eslint-disable`. So the STATE lives in the parent via
// `useRateEffectiveDate`, and `<RateEffectiveDateFields>` is a pure render of
// it. No cross-component setState anywhere, and no disable comment.
//
// ── Every gate here is a SECOND gate ─────────────────────────────────────
// The server refuses an unconfirmed decrease on its own
// (RateRepriceDecreaseNotConfirmedError, recomputed server-side from persisted
// state) and the engine and the zod schema each reject a future date
// independently. Nothing below is the only thing standing between Mark and a
// bad write — it is the part that makes the refusal legible BEFORE he clicks.
//
// ⚠️ The program edit dialog is ALWAYS MOUNTED and merely closed, and renders
// its own copy of these fields. Any page-wide selector (`input[name=...]`)
// matches the hidden copy too. Every control here therefore carries an
// explicit aria-label that names its SUBJECT ("…for Alex Milone on Elite
// Hitting"), so Phase E's harness can target one unambiguously.

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Loader2,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import type { RateRepricePreview } from "@/lib/server/rate-reprice";
import {
  buildRepricePreviewSummary,
  describeEffectiveMode,
  FUTURE_DATE_MESSAGE,
  formatShortDate,
  isFutureEffectiveDate,
  maxEffectiveDate,
  type EffectiveMode,
  type RepricePreviewSummary,
} from "@/lib/rate-reprice-copy";
import { decideRateEffectiveGate } from "@/lib/rate-effective-gate";
import { pfaWallClockToUtc } from "@/lib/timezone";

/** How long we wait after the last keystroke before asking the server. */
const PREVIEW_DEBOUNCE_MS = 350;

export type RunRatePreview = (
  effectiveFrom: Date,
) => Promise<RateRepricePreview | null>;

export type UseRateEffectiveDateOptions = {
  /**
   * Hidden input name the surrounding form submits the picked date under.
   * "effectiveFrom" for a per-coach override, "defaultRateEffectiveFrom" for a
   * program default — matching the two zod schemas.
   */
  name: string;
  /**
   * Who/what this rate is for, in Mark's words: "Alex Milone on Elite Hitting"
   * or "Elite Hitting". Used in every accessible name so the always-mounted
   * duplicate copies of these fields stay distinguishable.
   */
  subject: string;
  /** Archived coach / read-only surfaces. */
  disabled?: boolean;
  /**
   * Runs the READ-ONLY server preview for a chosen date, with the CANDIDATE
   * rate the admin has typed but not saved (SPEC §7 / Phase D1). Returns null
   * when the parent has nothing valid to price yet — a half-typed "4." is not
   * an error to shout about, it is just "no preview yet".
   */
  runPreview: RunRatePreview;
  /**
   * Changes whenever the candidate rate the parent would send changes. Drives
   * the refetch AND the "is this preview still about what's on screen" check —
   * a stale dollar figure next to a changed rate is the single most dangerous
   * thing this component could render.
   */
  candidateKey: string;
  /**
   * The preview attached to a server-side refusal
   * (RateRepriceDecreaseNotConfirmedError). Rendered with the same warning as
   * a client-side decrease so the race — client saw no decrease, server did —
   * lands on a usable screen instead of an error boundary.
   */
  serverDecreasePreview?: RateRepricePreview | null;
  /**
   * "YYYY-MM-DD" to re-open on, when the form is being remounted after a
   * failed submit. Both surfaces re-key their form on error, which remounts
   * everything below them — without this, a refused save would silently drop
   * Mark's backdate choice and leave him looking at "Going forward only" with
   * a decrease warning he can no longer act on.
   */
  initialDateValue?: string;
};

type PreviewState =
  | { key: null }
  | { key: string; status: "ready"; preview: RateRepricePreview }
  | { key: string; status: "no_candidate" }
  | { key: string; status: "error"; message: string };

export type RateEffectiveDateState = {
  options: UseRateEffectiveDateOptions;
  open: boolean;
  setOpen: (open: boolean) => void;
  mode: EffectiveMode;
  setMode: (mode: EffectiveMode) => void;
  dateValue: string;
  setDateValue: (value: string) => void;
  maxDate: string;
  /** The chip's summary line when collapsed. */
  chipLabel: string;
  /** null while collapsed-and-forward; otherwise the sentence under the mode. */
  helperText: string;
  /** "loading" | "ready" | "no_candidate" | "error" | "idle". */
  status: "idle" | "loading" | "ready" | "no_candidate" | "error";
  errorMessage: string | null;
  summary: RepricePreviewSummary | null;
  /** True when a decrease is on the table and has NOT been acknowledged. */
  needsDecreaseAck: boolean;
  acknowledged: boolean;
  setAcknowledged: (value: boolean) => void;
  /** 🔴 The parent's Save button must be disabled while this is true. */
  blocked: boolean;
  /** The value the hidden input submits — "" means "going forward only". */
  submittedValue: string;
};

/**
 * Owns every piece of effective-date state for one rate form.
 *
 * `blocked` is the contract with the parent: SPEC §7 says the preview appears
 * "before Save is armed", so a past date with no preview yet — still loading,
 * failed to load, or showing an unacknowledged decrease — must not be
 * saveable. Switching back to "Going forward only" always clears it, so this
 * can never trap someone: the escape hatch is the behavior that shipped
 * before this feature existed.
 */
export function useRateEffectiveDate(
  options: UseRateEffectiveDateOptions,
): RateEffectiveDateState {
  const {
    runPreview,
    candidateKey,
    serverDecreasePreview = null,
    initialDateValue = "",
  } = options;

  const [open, setOpen] = useState(initialDateValue !== "");
  const [mode, setModeRaw] = useState<EffectiveMode>(
    initialDateValue !== "" ? "back" : "forward",
  );
  const [dateValue, setDateValue] = useState(initialDateValue);
  const [previewState, setPreviewState] = useState<PreviewState>({ key: null });
  /** The request key that was acknowledged — not a bare boolean, so changing
   *  the date or the rate silently re-arms the hard stop. */
  const [ackKey, setAckKey] = useState<string | null>(null);

  // `now` is frozen for the life of the form. A date input whose `max` shifted
  // under the user at midnight would be a genuinely baffling bug, and the
  // server re-checks the boundary against its own clock anyway.
  const maxDate = useMemo(() => maxEffectiveDate(new Date()), []);

  const isFuture = isFutureEffectiveDate(dateValue, new Date(`${maxDate}T12:00:00Z`));
  const wantsPreview = mode === "back" && dateValue !== "" && !isFuture;
  const requestKey = wantsPreview ? `${dateValue}|${candidateKey}` : "";

  useEffect(() => {
    if (!requestKey) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          // The picked "YYYY-MM-DD" is a PFA WALL-CLOCK day, so it becomes an
          // instant the same way the save path does it. Sending the bare
          // string would let zod's `new Date("2026-06-19")` read it as UTC
          // midnight — 5pm the PREVIOUS day in California — and quietly pull
          // an extra evening of logs into the window the preview quotes.
          const effectiveFrom = pfaWallClockToUtc(dateValue, "00:00");
          const preview = await runPreview(effectiveFrom);
          if (cancelled) return;
          setPreviewState(
            preview
              ? { key: requestKey, status: "ready", preview }
              : { key: requestKey, status: "no_candidate" },
          );
        } catch (err) {
          if (cancelled) return;
          setPreviewState({
            key: requestKey,
            status: "error",
            message:
              err instanceof Error && err.message
                ? err.message
                : "Couldn't check what this would change.",
          });
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `runPreview` is rebuilt on every parent render; `candidateKey` is the
    // value that actually decides whether the answer would differ, and it is
    // baked into requestKey. Depending on the function identity instead would
    // refetch on every keystroke in an unrelated field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, dateValue]);

  // Derived, never stored: a result whose key no longer matches what is on
  // screen is by definition stale, so "loading" needs no separate flag and
  // cannot get stuck on.
  const fresh = requestKey !== "" && previewState.key === requestKey;
  const status: RateEffectiveDateState["status"] = !wantsPreview
    ? "idle"
    : fresh
      ? (previewState as Exclude<PreviewState, { key: null }>).status
      : "loading";

  const preview =
    fresh && previewState.key !== null && previewState.status === "ready"
      ? previewState.preview
      : null;

  const summary = preview ? buildRepricePreviewSummary(preview) : null;

  // A server refusal only outranks the client preview when the client one has
  // nothing to say about a decrease — i.e. exactly the race the refusal
  // exists to catch.
  const decreasePreview =
    summary?.decrease != null
      ? preview
      : (serverDecreasePreview?.decreases.logCount ?? 0) > 0
        ? serverDecreasePreview
        : null;
  const decreaseSummary =
    decreasePreview && decreasePreview !== preview
      ? buildRepricePreviewSummary(decreasePreview)
      : summary;

  const acknowledged = ackKey !== null && ackKey === requestKey;
  const hasDecrease = (decreaseSummary?.decrease ?? null) !== null;

  // The whole "is Save armed / what do we submit / does confirmDecrease ride
  // along" decision lives in one pure, unit-tested function. See
  // @/lib/rate-effective-gate — the branches that say NO are the point.
  const gate = decideRateEffectiveGate({
    mode,
    dateValue,
    isFuture,
    status,
    hasDecrease,
    acknowledged,
  });
  const needsDecreaseAck = hasDecrease && !acknowledged;

  const setMode = (next: EffectiveMode) => {
    setModeRaw(next);
    // Opening the panel is implied by choosing to reach backwards; closing it
    // is not implied by anything, so "Going forward only" leaves it open.
    if (next === "back") setOpen(true);
    setAckKey(null);
  };

  const setDate = (value: string) => {
    setDateValue(value);
    setAckKey(null);
  };

  const helperText = describeEffectiveMode(mode, dateValue);

  const chipLabel =
    mode === "forward"
      ? "Going forward only"
      : dateValue === ""
        ? "Apply back to…"
        : `Applies back to ${formatShortDate(
            new Date(`${dateValue}T12:00:00Z`),
          )}`;

  return {
    options,
    open,
    setOpen,
    mode,
    setMode,
    dateValue,
    setDateValue: setDate,
    maxDate,
    chipLabel,
    helperText,
    status,
    errorMessage:
      status === "error"
        ? (previewState as { message: string }).message
        : isFuture
          ? FUTURE_DATE_MESSAGE
          : null,
    summary: decreaseSummary,
    needsDecreaseAck,
    acknowledged,
    setAcknowledged: (value: boolean) => setAckKey(value ? requestKey : null),
    blocked: gate.blocked,
    // "" is the "going forward only" signal every form action reads as
    // "absent". It is what makes the default path byte-identical to the
    // behavior that shipped before effective dating existed.
    submittedValue: gate.submittedValue,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The render
// ─────────────────────────────────────────────────────────────────────────

export function RateEffectiveDateFields({
  state,
}: {
  state: RateEffectiveDateState;
}) {
  const { options, mode, summary } = state;
  const { subject, disabled = false, name } = options;
  const decrease = summary?.decrease ?? null;

  return (
    <div className="mt-2" data-rate-effective-date={subject}>
      {/* ALWAYS submitted, both modes. An empty value is "going forward
          only" — the server treats absent and empty identically. */}
      <input type="hidden" name={name} value={state.submittedValue} readOnly />

      {!state.open ? (
        <button
          type="button"
          onClick={() => state.setOpen(true)}
          disabled={disabled}
          aria-label={`When this rate starts for ${subject}: ${state.chipLabel}. Change it.`}
          className="inline-flex items-center gap-1.5 rounded-md border border-line px-2 h-7 text-[11px] font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        >
          <CalendarClock className="h-3.5 w-3.5" aria-hidden="true" />
          {state.chipLabel}
        </button>
      ) : (
        <div className="rounded-lg border border-line bg-surface-2/50 p-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-fg-muted">
            When this rate starts
          </p>

          <div
            role="radiogroup"
            aria-label={`When the new rate for ${subject} starts`}
            className="inline-flex rounded-lg border border-line p-0.5"
          >
            <ModeRadio
              checked={mode === "forward"}
              disabled={disabled}
              onClick={() => state.setMode("forward")}
              label={`Going forward only — leave hours already logged for ${subject} alone`}
            >
              Going forward only
            </ModeRadio>
            <ModeRadio
              checked={mode === "back"}
              disabled={disabled}
              onClick={() => state.setMode("back")}
              label={`Apply back to a past date — re-price hours already logged for ${subject}`}
            >
              Apply back to…
            </ModeRadio>
          </div>

          {mode === "back" ? (
            <div className="mt-2">
              <input
                type="date"
                value={state.dateValue}
                max={state.maxDate}
                disabled={disabled}
                onChange={(e) => state.setDateValue(e.target.value)}
                aria-label={`Apply the new rate for ${subject} back to this date (today or earlier)`}
                className="w-full max-w-[200px] rounded-md border border-line bg-surface px-3 h-9 text-sm text-fg focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40 disabled:opacity-60"
              />
            </div>
          ) : null}

          <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
            {state.helperText}
          </p>

          {state.status === "loading" ? (
            <p
              role="status"
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg-muted"
            >
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
              Checking what this would change…
            </p>
          ) : null}

          {state.status === "no_candidate" ? (
            <p className="mt-2 text-[11px] text-fg-muted">
              Enter the rate above first — then this will show exactly what
              changes.
            </p>
          ) : null}

          {state.errorMessage ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-2 text-[11px] text-danger"
            >
              {state.errorMessage} Save is held until this can be checked —
              switch back to &ldquo;Going forward only&rdquo; if you just want
              the new rate from here on.
            </p>
          ) : null}

          {summary ? (
            <div
              data-reprice-direction={summary.direction}
              className={`mt-2 rounded-md border px-2.5 py-2 ${
                // 🔴 DIRECTION, CARRIED BY THE BOX ITSELF. A raise and a cut
                // used to render identically here — the only difference was
                // the sign inside the sentence and the red block underneath,
                // and on a tall card that block can sit below the fold. Colour
                // + a matching arrow beside the headline make "this goes DOWN"
                // legible before the sentence is read.
                summary.direction === "decrease"
                  ? "border-danger/40 bg-danger/5"
                  : summary.direction === "increase"
                    ? "border-success/40 bg-success/5"
                    : summary.hasChanges
                      ? "border-line-strong bg-surface"
                      : "border-line bg-surface"
              }`}
            >
              <p
                data-reprice-summary=""
                className="flex items-start gap-1.5 text-[11.5px] font-medium leading-relaxed text-fg"
              >
                {summary.direction !== "none" ? (
                  <DirectionIcon direction={summary.direction} />
                ) : null}
                {/* The signed delta is a `nowrap` run: a break between the
                    U+2212 MINUS SIGN and its amount ("(−" / "$120.00).")
                    destroys exactly the cue the minus sign was chosen for.
                    The segments carry no whitespace between them, so the
                    rendered text is the `headline` string verbatim. */}
                <span>
                  {summary.headlineParts.map((part, i) => (
                    <span
                      key={i}
                      className={part.nowrap ? "whitespace-nowrap" : undefined}
                    >
                      {part.text}
                    </span>
                  ))}
                </span>
              </p>
              {summary.excludedLine ? (
                <p
                  data-reprice-excluded=""
                  className="mt-1.5 text-[11px] leading-relaxed text-fg-muted"
                >
                  {summary.excludedLine}
                </p>
              ) : null}
              {summary.provenanceLine ? (
                <p
                  data-reprice-provenance=""
                  className="mt-1.5 text-[11px] leading-relaxed text-fg-muted"
                >
                  {summary.provenanceLine}
                </p>
              ) : null}
              {summary.heldLine ? (
                <p
                  data-reprice-held=""
                  className="mt-1.5 text-[11px] leading-relaxed text-fg-muted"
                >
                  {summary.heldLine}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* 🔴 SPEC §6 — the hard stop. INLINE, never a nested overlay: the
              program surface renders these fields inside a native <dialog> in
              the browser top layer, where a separate fixed-position confirm
              would draw BEHIND the dialog it is trying to interrupt. That
              lesson is recorded in the rental-delete work. */}
          {decrease ? (
            <div
              role="alert"
              data-reprice-decrease=""
              className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2"
            >
              <p className="flex items-start gap-1.5 text-[11.5px] font-semibold text-danger">
                <ShieldAlert
                  className="mt-px h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                {decrease.headline}
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {decrease.coachLines.map((line) => (
                  <li
                    key={line}
                    className="text-[11.5px] font-medium text-danger font-mono tnum tabular-nums"
                  >
                    {line}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted">
                {decrease.reassurance}
              </p>

              {/* The deliberate SECOND confirmation. A real required checkbox,
                  not a styled div: `confirmDecrease` is simply not present in
                  the payload until it is ticked, and the browser refuses to
                  submit the form while it is required-and-unticked. The server
                  refuses too (RateRepriceDecreaseNotConfirmedError) — this is
                  the layer that makes the refusal legible first. */}
              <label className="mt-2 flex items-start gap-2 text-[11.5px] font-medium text-fg">
                <input
                  type="checkbox"
                  name="confirmDecrease"
                  value="true"
                  required
                  checked={state.acknowledged}
                  disabled={disabled}
                  onChange={(e) => state.setAcknowledged(e.target.checked)}
                  aria-label={`Confirm lowering already-logged pay for ${subject}`}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[color:var(--danger)]"
                />
                <span>{decrease.acknowledgeLabel}</span>
              </label>
            </div>
          ) : null}

          {state.blocked && !decrease && state.status !== "error" ? (
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
              <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              Save unlocks once this shows what will change.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The direction cue beside the headline.
 *
 * `aria-hidden` and text-free on purpose: it carries no information a screen
 * reader would otherwise miss (the sentence already says "+$440.00" /
 * "−$120.00" and the decrease warning below spells the direction out in
 * words), and any text here would land inside `[data-reprice-summary]`, which
 * the live-QA harness compares to an exactly-computed sentence.
 */
function DirectionIcon({ direction }: { direction: "increase" | "decrease" }) {
  const Icon = direction === "decrease" ? TrendingDown : TrendingUp;
  return (
    <Icon
      aria-hidden="true"
      className={`mt-px h-3.5 w-3.5 shrink-0 ${
        direction === "decrease" ? "text-danger" : "text-success"
      }`}
    />
  );
}

function ModeRadio({
  checked,
  disabled,
  onClick,
  label,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  /**
   * The EXPLICIT accessible name. A previous phase shipped a mode button whose
   * accessible name was the raw concatenation of its visible title and hint —
   * unreadable in a screen reader and unstable to target from a test. Never
   * let these fall back to their text content.
   */
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`px-2.5 h-7 rounded-md text-[11px] font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
        checked
          ? "bg-gold text-gold-ink shadow-[var(--shadow-sm)]"
          : "text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
