"use client";

// ADMIN HOUR ENTRY — "Log hours for a coach".
//
// The one screen in the product that creates an hour log for somebody other
// than the signed-in user. Until it existed, an admin could edit and delete a
// coach's hours but could not make them, so work a coach never logged could
// never be paid.
//
// ── IT RECORDS ONE SHIFT FOR AS MANY COACHES AS WORKED IT ────────────────
// The coach picker is a checkbox group, not a select. Recording a shift is
// ONE decision by the operator, and a two-coach shift used to mean running
// this dialog twice — with the schedule sitting half-recorded in between,
// looking exactly like something had gone wrong. One submit now writes one
// separate, separately-priced row per coach, raises ONE set of warnings
// naming whoever they are about, and takes ONE confirmation.
//
// ── 🔴 THE FORM IS MOUNTED ONLY WHILE THE DIALOG IS OPEN ─────────────────
// `useActionState` lives in the inner component, which is conditionally
// rendered, so closing the dialog UNMOUNTS the failure state rather than
// leaving it behind a hidden element. That is deliberately the structural fix
// from open item 0a rather than the shape used by the edit dialog beside it:
// `PaymentDialog` kept its form mounted, nothing reset the action state on
// close, and a rejected submit followed by a dismiss left the NEXT record's
// form pre-filled with the previous one's values while carrying the new id —
// which on that screen silently rewrote another payment's amount and
// direction. On a form whose entire job is writing payable rows for a
// named coach, "close and reset are the same event" has to be structural.
//
// ── THE THREE-STATE RESULT ───────────────────────────────────────────────
// A submit comes back as success, an ERROR (red — the admin must change
// something), or a DECISION (amber — nothing is wrong, but there is an
// overlapping log or an already-settled period he should see first). The
// decision renders a second submit button carrying `confirm=true` in its own
// name/value, so only the click that says "go ahead" ever sends it and a plain
// re-submit cannot inherit a stale confirmation from a hidden field.

import { useActionState, useEffect, useRef, useState } from "react";
import { Plus, TriangleAlert, X } from "lucide-react";
import {
  logHoursForCoachFormAction,
  type LogHoursForCoachResult,
} from "../form-actions";
import { TimeSelect } from "@/app/_components/time-select";
import { DateInput } from "@/app/_components/date-input";

export type LogHoursCoachOption = {
  id: string;
  name: string | null;
  email: string;
};

export type LogHoursProgramOption = {
  id: string;
  name: string;
  active: boolean;
};

const INITIAL_STATE: LogHoursForCoachResult = { ok: true, notice: null };

export function LogHoursForCoachDialog({
  open,
  onClose,
  coaches,
  programs,
}: {
  open: boolean;
  onClose: () => void;
  coaches: LogHoursCoachOption[];
  programs: LogHoursProgramOption[];
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
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

  return (
    <dialog
      ref={dialogRef}
      className="m-auto w-full max-w-lg rounded-lg border border-line bg-surface text-fg p-0 backdrop:bg-page/70 backdrop:backdrop-blur-sm"
    >
      {/* Unmounted while closed — see the module note. */}
      {open ? (
        <LogHoursForCoachForm
          onClose={onClose}
          coaches={coaches}
          programs={programs}
        />
      ) : null}
    </dialog>
  );
}

function LogHoursForCoachForm({
  onClose,
  coaches,
  programs,
}: {
  onClose: () => void;
  coaches: LogHoursCoachOption[];
  programs: LogHoursProgramOption[];
}) {
  const [state, formAction, pending] = useActionState(
    logHoursForCoachFormAction,
    INITIAL_STATE,
  );

  // 🔴 CLOSE ON A SUCCESSFUL SUBMIT — AND NOT BY WATCHING `pending`.
  //
  // The obvious version (the one the edit dialog beside this uses) latches a
  // ref while `pending` is true and closes on the next render where it is
  // false. That depends on React actually RENDERING an intermediate pending
  // state, and it does not always: against a local database the action can
  // resolve inside the same batch, the pending render never happens, the latch
  // is never set, and the dialog sits open over a blank form as though the
  // save had failed. Found by pressing the button and looking, after the row
  // had already been written — every assertion around it was green.
  //
  // `useActionState` returns the INITIAL object by identity until an action
  // resolves, so `state !== INITIAL_STATE` is an exact, timing-free statement
  // of "an action has completed", and `state.ok` narrows it to a successful
  // one. No latch, no dependence on how fast the server answered.
  useEffect(() => {
    // 🔴 A NOTICE HOLDS THE DIALOG OPEN. The hours are written either way, but
    // a notice means the SCHEDULE did not end up matching them (a retired
    // program has no schedule to add to; the block write failed after the pay
    // was committed). Closing on that would leave the admin looking at a grid
    // that still says nobody worked, with nothing anywhere having said why —
    // and his reasonable response is to enter the hours again.
    if (state !== INITIAL_STATE && state.ok && state.notice === null) onClose();
  }, [state, onClose]);

  const values = state.ok ? null : state.values;
  const activePrograms = programs.filter((p) => p.active);
  const retiredPrograms = programs.filter((p) => !p.active);

  // 🔴 EVERY FIELD IS UNCONTROLLED, AND THE FORM REMOUNTS ON A NEW RESULT.
  //
  // React applies `defaultValue` at MOUNT ONLY, so without this key a decision
  // coming back would re-render the form in place and every field would snap
  // to its initial value — found by filling the form in a browser and pressing
  // the button, not by any assertion. The admin would then read "these hours
  // overlap one already recorded" above an empty form, with nothing left to
  // confirm. Keying on the result identity is the same remount the edit dialog
  // beside this one uses.
  //
  // 📌 An earlier draft held the coach in `useState` instead. That state was
  // never read anywhere but the select's own `value`, which made the field
  // controlled for no benefit and reverted the admin's choice on every
  // re-render — a control that looks like it does something and does not
  // (rule 27). Deleted rather than repaired.
  // 🔴 KEYED ON COACH *AND* KIND. One submit can now warn about several
  // coaches, and two of those warnings are routinely the same `kind` — so a
  // key built from kinds alone would be identical for "Alpha overlaps" and
  // "Alpha and Bravo both overlap", and the form would NOT remount between
  // them. It would then re-render in place with every field snapped back to
  // its mount-time value, leaving the admin reading a warning above a form
  // that had lost his input.
  const formKey = state.ok
    ? "fresh"
    : state.kind === "error"
      ? `err-${state.error.code}`
      : `decide-${state.warnings
          .map((w) => `${w.coachId}:${w.kind}`)
          .join("|")}`;

  return (
    <form action={formAction} key={formKey} className="space-y-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.14em] text-fg-muted">
            Work log
          </p>
          <h2 className="text-xl font-semibold tracking-tight mt-0.5">
            Log hours for a coach
          </h2>
          <p className="text-xs text-fg-subtle mt-1">
            Records the hours as worked and pays them straight away — the
            coaches don&apos;t need to do anything.
          </p>
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

      {state.ok && state.notice !== null ? (
        <div
          role="status"
          className="rounded-md border border-line bg-surface-2 px-3 py-3 text-xs text-fg space-y-3"
        >
          <p>{state.notice}</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line bg-surface hover:border-line-strong h-8 px-3 text-xs font-medium transition-colors"
          >
            Done
          </button>
        </div>
      ) : null}

      {!state.ok && state.kind === "error" ? (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {state.error.message}
        </div>
      ) : null}

      <div className="space-y-3">
        {/*
          🔴 A CHECKBOX GROUP, NOT A SELECT — one shift is routinely worked by
          more than one person.

          With a single select, recording a two-coach shift meant running this
          dialog twice, and between the two runs the schedule sat half-recorded
          in a state that reads exactly like something went wrong. That is what
          happened the first morning this feature was used on production.

          Every box carries the SAME name, so the browser submits one value per
          ticked coach and `formData.getAll` reads the set. No hidden companion
          input is needed here (unlike the stipend checkbox, which has to tell
          "unticked" apart from "the form never asked"): an empty list is a
          real, meaningful answer — nobody was picked — and the schema refuses
          it with a sentence written for the admin.
        */}
        <fieldset>
          <legend className="text-xs uppercase tracking-wider text-fg-muted mb-1.5">
            Coaches who worked it
          </legend>
          <div className="max-h-44 overflow-y-auto rounded-md border border-line bg-page divide-y divide-line/60">
            {coaches.map((c) => {
              const label = c.name ?? c.email;
              return (
                <label
                  key={c.id}
                  className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-surface-2 transition-colors"
                >
                  <input
                    type="checkbox"
                    name="coachIds"
                    value={c.id}
                    defaultChecked={values?.coachIds?.includes(c.id) ?? false}
                    className="h-4 w-4 rounded border-line accent-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
                  />
                  <span>{label}</span>
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-fg-subtle mt-1.5">
            Tick everyone who worked this shift — each one is recorded and paid
            separately.
          </p>
        </fieldset>

        <Field label="Program">
          {/*
            Retired programs are offered here and nowhere else. The headline
            case for this form is hours from months ago — a summer program that
            has since been switched off is the ordinary shape of that, not an
            edge case. They are grouped and labelled rather than mixed in, so
            picking one is a deliberate act.
          */}
          <select
            name="programId"
            required
            aria-label="Program the hours were worked on"
            defaultValue={values?.programId ?? ""}
            className={selectStyles}
          >
            <option value="">Select a program…</option>
            {activePrograms.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {retiredPrograms.length > 0 ? (
              <optgroup label="Retired programs">
                {retiredPrograms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Date">
            <DateInput
              name="date"
              required
              defaultValue={values?.date ?? ""}
              className={inputStyles}
            />
          </Field>
          <Field label="Start">
            <TimeSelect
              name="startTime"
              variant="start"
              required
              defaultValue={values?.startTime || "09:00"}
              className={selectStyles}
            />
          </Field>
          <Field label="End">
            <TimeSelect
              name="endTime"
              variant="end"
              required
              defaultValue={values?.endTime || "10:00"}
              className={selectStyles}
            />
          </Field>
        </div>

        <Field label="Note" optional>
          <input
            type="text"
            name="note"
            defaultValue={values?.note ?? ""}
            maxLength={2000}
            placeholder="Why you are entering this — e.g. covered for Lucas"
            className={inputStyles}
          />
        </Field>
      </div>

      {!state.ok && state.kind === "decision" ? (
        <div
          role="alert"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-3 text-xs text-fg space-y-2"
        >
          <div className="flex items-start gap-2">
            <TriangleAlert
              aria-hidden
              className="h-4 w-4 shrink-0 mt-px text-warning"
            />
            <div className="space-y-2">
              <p className="font-medium">Before this is recorded</p>
              {/* Keyed by coach AND kind: with several coaches in one submit
                  two warnings can share a kind, and a duplicate React key
                  drops one of them — the dropped coach being the one about to
                  be paid twice. */}
              {state.warnings.map((w) => (
                <p key={`${w.coachId}:${w.kind}`}>{w.message}</p>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-9 px-4 text-sm font-medium transition-colors"
        >
          Cancel
        </button>
        {!state.ok && state.kind === "decision" ? (
          // The ONLY thing that sends `confirm=true`, and it sends it from the
          // clicked submit's own name/value — a hidden field would persist
          // across a later edit-and-resubmit and quietly pre-confirm a warning
          // the admin never saw.
          <button
            type="submit"
            name="confirm"
            value="true"
            disabled={pending}
            className="rounded-md border border-warning/50 bg-warning/20 hover:bg-warning/30 h-9 px-4 text-sm font-medium text-fg disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning/40 transition-colors"
          >
            {pending ? "Recording…" : "Record them anyway"}
          </button>
        ) : (
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-gold text-gold-ink hover:bg-gold-hover h-9 px-4 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
          >
            {pending ? "Recording…" : "Record hours"}
          </button>
        )}
      </div>
    </form>
  );
}

function Field({
  label,
  optional,
  children,
}: {
  label: string;
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
    </label>
  );
}

const inputStyles =
  "w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40";
const selectStyles = `${inputStyles} appearance-none pr-8`;

/**
 * The entry point on /admin/hour-log. Owns only the open/closed state — the
 * dialog itself keeps no state at all while closed (see the module note).
 */
export function LogHoursForCoachButton({
  coaches,
  programs,
}: {
  coaches: LogHoursCoachOption[];
  programs: LogHoursProgramOption[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-lg bg-gold text-gold-ink hover:bg-gold-hover px-4 h-9 text-sm font-medium shadow-[var(--shadow-sm)] hover:-translate-y-px hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
      >
        <Plus className="h-4 w-4" />
        Log hours for a coach
      </button>
      <LogHoursForCoachDialog
        open={open}
        onClose={() => setOpen(false)}
        coaches={coaches}
        programs={programs}
      />
    </>
  );
}
