"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import {
  updateProgramFormAction,
  type EditProgramResult,
} from "../form-actions";
import {
  getProgramDefaultRateHistory,
  previewProgramDefaultRateReprice,
} from "../actions";
import {
  ProgramFields,
  useProgramPayFields,
  type ProgramFieldDefaults,
} from "./program-fields";
import { programPayCandidateKey } from "@/lib/program-pay-fields";
import {
  RateEffectiveDateFields,
  useRateEffectiveDate,
  type RunRatePreview,
} from "@/app/_components/rate-effective-date";
import { RateHistoryMenu } from "@/app/_components/rate-history-menu";
import {
  tryFlatDollarsToCents,
  tryOptionalHourlyDollarsToCentsPer30Min,
} from "@/lib/rate-input";
import { buildRepriceAppliedMessage } from "@/lib/rate-reprice-copy";

export type ProgramEditInitialValues = {
  id: string;
  name: string;
  defaultRatePer30MinCents: number | null;
  // 0052 — how this program pays. "hourly" for every program created before
  // the migration (the column default).
  payMode: "hourly" | "per_session";
  defaultPerSessionRateCents: number | null;
};

// Native <dialog> edit form for a single program (name + optional pay
// rate via the shared ProgramFields) using useActionState +
// updateProgramFormAction, auto-closing on success. Mirrors
// admin/attendance/roster/_components/athlete-edit-dialog.tsx. Create
// mode lives in the inline AddProgramForm at the top of the page.
//
// SPEC rate-effective-dating §7 — this dialog is the "rate dialog": the
// effective-date control lives INSIDE it, under the rate field, collapsed to a
// chip until Mark asks to reach backwards. The §6 preview and the 🔴 decrease
// hard stop render INLINE inside it, never as a nested overlay — this is a
// native <dialog> in the browser top layer, where a separate fixed-position
// confirm draws BEHIND the dialog it is trying to interrupt (the lesson
// recorded in the rental-delete work).

const INITIAL_STATE: EditProgramResult = { ok: true };

export function ProgramFormDialog({
  open,
  onClose,
  initial,
}: {
  open: boolean;
  onClose: () => void;
  initial?: ProgramEditInitialValues;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useActionState(
    updateProgramFormAction,
    INITIAL_STATE,
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Auto-close after a successful submit.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && state.ok && open) {
      onClose();
    }
    wasPending.current = pending;
  }, [pending, state, open, onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handler = () => {
      if (open) onClose();
    };
    dialog.addEventListener("close", handler);
    return () => dialog.removeEventListener("close", handler);
  }, [open, onClose]);

  const defaults: ProgramFieldDefaults = useMemo(() => {
    if (!state.ok && state.values) {
      return state.values;
    }
    if (initial) {
      return {
        name: initial.name,
        // Rates are STORED per 30 min but ENTERED/DISPLAYED per hour, so
        // double the stored cents (× 2 / 100) for the prefilled value.
        rateDollars:
          initial.defaultRatePer30MinCents !== null
            ? ((initial.defaultRatePer30MinCents * 2) / 100).toFixed(2)
            : "",
        payMode: initial.payMode,
        // Per-session is a FLAT amount — not halved, unlike the hourly rate.
        perSessionDollars:
          initial.defaultPerSessionRateCents != null
            ? (initial.defaultPerSessionRateCents / 100).toFixed(2)
            : "",
      };
    }
    return {
      name: "",
      rateDollars: "",
      payMode: "hourly" as const,
      perSessionDollars: "",
    };
  }, [initial, state]);

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-xl border border-line bg-surface text-fg p-0 shadow-[var(--shadow-lg)] backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        key={
          state.ok
            ? `edit-${initial?.id ?? "none"}`
            : `edit-err-${state.error.code}-${state.error.message}`
        }
        className="space-y-5 p-6"
      >
        <input type="hidden" name="id" defaultValue={initial?.id ?? ""} />

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
              Edit
            </p>
            <h2 className="mt-0.5 text-xl font-semibold tracking-tight">
              Program
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
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

        {/* Keyed on the program id so switching rows re-seeds the live pay
            values and clears any half-configured retro. Lives inside the
            form (and therefore inside the keyed remount) so a failed submit
            re-seeds it from the echoed-back values too. */}
        <ProgramEditBody
          key={initial?.id ?? "none"}
          initial={initial}
          defaults={defaults}
          state={state}
          pending={pending}
          onClose={onClose}
        />
      </form>
    </dialog>
  );
}

/**
 * The pay half of the dialog plus the footer buttons.
 *
 * Separate component because the effective-date control needs the LIVE pay
 * fields (to preview the candidate rate) and the footer needs `blocked` (to
 * disarm Save until the preview has been seen). Keeping both in one child
 * means neither is a callback into a parent's state — no cross-component
 * setState, no `react-hooks/set-state-in-effect` disable.
 */
function ProgramEditBody({
  initial,
  defaults,
  state,
  pending,
  onClose,
}: {
  initial?: ProgramEditInitialValues;
  defaults: ProgramFieldDefaults;
  state: EditProgramResult;
  pending: boolean;
  onClose: () => void;
}) {
  const programId = initial?.id ?? "";
  const programName = initial?.name ?? "this program";

  /**
   * 🔴 THE ONE SOURCE OF TRUTH for both pay amounts.
   *
   * The amount inputs render `fields.values` (controlled, both always
   * mounted — see program-fields.tsx) and the preview below prices
   * `fields.values`. There is no second copy: the `useRef` mirror this used to
   * keep is gone, and with it the P0 where toggling the pay mode remounted an
   * uncontrolled input, re-seeded it from `defaults`, and left the DOM and the
   * preview quoting different numbers.
   */
  const fields = useProgramPayFields(defaults);
  const live = fields.values;

  /**
   * SPEC §7 / Phase D1 — preview the rate that is TYPED, not the one on the
   * row. `previewProgramDefaultRateReprice` is read-only and admin-gated; the
   * engine substitutes this hypothetical PROGRAM config and nothing else, so
   * a coach holding their own override on this program is still unreachable
   * (SPEC §5) and still comes back named on `excludedCoaches`.
   */
  const runPreview: RunRatePreview = useCallback(
    async (effectiveFrom) => {
      if (!programId) return null;
      const perSession = live.payMode === "per_session";
      const defaultPerSessionRateCents = perSession
        ? tryFlatDollarsToCents(live.perSessionDollars)
        : null;
      const defaultRatePer30MinCents = perSession
        ? null
        : tryOptionalHourlyDollarsToCentsPer30Min(live.rateDollars);
      // Per-session with no amount is not a rate, it is a $0 trap — the same
      // cross-field rule updateProgramSchema enforces on save. Show nothing
      // rather than a preview priced at zero.
      if (perSession && defaultPerSessionRateCents == null) return null;
      return previewProgramDefaultRateReprice({
        scope: { kind: "program_default", programId },
        effectiveFrom,
        candidateRate: {
          kind: "program_default",
          payMode: live.payMode,
          defaultRatePer30MinCents,
          defaultPerSessionRateCents,
        },
      });
    },
    [programId, live],
  );

  const effectiveDate = useRateEffectiveDate({
    name: "defaultRateEffectiveFrom",
    subject: programName,
    runPreview,
    candidateKey: programPayCandidateKey(live),
    serverDecreasePreview: !state.ok ? (state.decreasePreview ?? null) : null,
    initialDateValue: !state.ok ? (state.values.effectiveFrom ?? "") : "",
  });

  const applied = state.ok && state.reprice ? state.reprice : null;

  return (
    <>
      <ProgramFields
        defaults={defaults}
        fields={fields}
        rateAside={
          programId ? (
            <RateHistoryMenu
              subject={programName}
              load={() => getProgramDefaultRateHistory(programId)}
            />
          ) : null
        }
        rateFooter={
          // Only in a real edit. With no program id there is nothing to
          // re-price, and rendering the hidden inputs anyway would leave a
          // second copy of them in the always-mounted closed dialog.
          programId ? <RateEffectiveDateFields state={effectiveDate} /> : null
        }
      />

      {applied ? (
        <p
          role="status"
          className="rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-fg-muted"
        >
          {buildRepriceAppliedMessage(applied)}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="h-9 rounded-md border border-line bg-surface-2 px-4 text-sm font-medium text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || effectiveDate.blocked}
          aria-label={`Save changes to ${programName}`}
          className="h-9 rounded-md bg-gold px-4 text-sm font-medium text-gold-ink shadow-[var(--shadow-sm)] transition-colors hover:bg-gold-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
        >
          {pending ? "Saving…" : "Save changes"}
        </button>
      </div>
    </>
  );
}
