"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import {
  recordPaymentFormAction,
  updatePaymentFormAction,
  type PaymentActionResult,
} from "../form-actions";
import type { CoachOption } from "./payments-client";
import { formatPfaDate } from "@/lib/timezone";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/schemas/payment";

// Native <dialog> form for recording or editing a coach payment.
// Mirrors the pattern in src/app/admin/sessions/_components/session-form-dialog.tsx:
//   - useActionState wrapping the form-action returns a discriminated
//     union; failed submits remount with `values` echoed back.
//   - Auto-close on success via the wasPending ref trick.
//   - Native <dialog> close event listened to so the Esc key + backdrop
//     click flow back through React state.

export type PaymentInitialValues = {
  id: string;
  coachId: string;
  amountCents: number;
  method: PaymentMethod;
  paidAt: Date;
  reference: string | null;
  note: string | null;
};

const INITIAL_STATE: PaymentActionResult = { ok: true };

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
  const action =
    mode === "edit" ? updatePaymentFormAction : recordPaymentFormAction;
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

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

  const defaults = useMemo(() => {
    if (!state.ok && state.values) {
      return state.values;
    }
    if (initial) {
      return {
        coachId: initial.coachId,
        amountDollars: centsToDollarsInput(initial.amountCents),
        method: initial.method,
        paidAtDate: formatPfaDate(initial.paidAt),
        reference: initial.reference ?? "",
        note: initial.note ?? "",
      };
    }
    return {
      coachId: prefillCoachId ?? "",
      amountDollars: "",
      method: "venmo" as string,
      paidAtDate: formatPfaDate(new Date()),
      reference: "",
      note: "",
    };
  }, [initial, prefillCoachId, state]);

  // Controlled coach + method to make the Pay-button repaint snappy
  // and so prefillCoachId from a row's "Record" button is honored.
  const [coachId, setCoachId] = useState(defaults.coachId);
  const [method, setMethod] = useState(defaults.method);
  const [prevDefaults, setPrevDefaults] = useState(defaults);
  if (defaults !== prevDefaults) {
    setPrevDefaults(defaults);
    setCoachId(defaults.coachId);
    setMethod(defaults.method);
  }

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      <form
        action={formAction}
        key={
          state.ok
            ? `${mode}-${initial?.id ?? "new"}`
            : `${mode}-err-${state.error.code}-${state.error.message}`
        }
        className="space-y-5 p-6"
      >
        {mode === "edit" && initial ? (
          <input type="hidden" name="id" defaultValue={initial.id} />
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
              value={coachId}
              onChange={(e) => setCoachId(e.target.value)}
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
                  defaultValue={defaults.amountDollars}
                  placeholder="0.00"
                  className={`${inputStyles} pl-7`}
                />
              </div>
            </Field>

            <Field label="Date">
              <input
                type="date"
                name="paidAtDate"
                required
                defaultValue={defaults.paidAtDate}
                className={inputStyles}
              />
            </Field>
          </div>

          <Field label="Method">
            <select
              name="method"
              required
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className={selectStyles}
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Reference"
            optional
            hint="Venmo txn id, check #, etc."
          >
            <input
              type="text"
              name="reference"
              defaultValue={defaults.reference}
              maxLength={200}
              placeholder="Optional"
              className={inputStyles}
            />
          </Field>

          <Field label="Note" optional>
            <input
              type="text"
              name="note"
              defaultValue={defaults.note}
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
    </dialog>
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

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;

function centsToDollarsInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
