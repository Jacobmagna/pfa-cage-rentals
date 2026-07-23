"use client";

// 1b security B: the admin held-log "Details + edit-then-approve" modal. Opened
// per held row from HeldRowActions. It lazily fetches the full detail
// (getHeldLogDetail) on open, then shows a SIDE-BY-SIDE compare of what the
// coach LOGGED vs the SCHEDULED block they were supposed to work — including
// each side's pay — so the admin can see exactly why the log was held and what
// the difference costs. The admin can correct the logged start/end times
// (15-min granularity, same date), one-click "Use scheduled time" to snap to
// the block, then Approve (with or without an edit) or Reject. Approve with
// unchanged times sends NO edit (fast path); a changed time sends the corrected
// ISO window and the server recomputes pay/hours + validates (end > start,
// ≤16h, no duplicate-times collision — surfaced inline). Mirrors the
// AcceptDialog chrome (backdrop / focus / Esc / TimeSelect) faithfully.

import { useEffect, useRef, useState, useTransition } from "react";
import { Check } from "lucide-react";
import {
  approveHeldHourLog,
  getHeldLogDetail,
} from "@/app/admin/hour-log/actions";
import type { HeldLogDetail } from "@/lib/server/hour-log-actions";
import {
  formatPfaDate,
  formatPfaDateMedium,
  formatPfaTime,
  formatPfaTime12h,
  parsePfaInput,
} from "@/lib/timezone";
import { TimeSelect } from "@/app/_components/time-select";

// Same held-issue labels as the queue table (page.tsx) — kept local so the
// pill reads identically in both places.
const ISSUE_LABEL: Record<string, string> = {
  unscheduled: "Not on schedule",
  wrong_time: "Wrong time",
  over_logged: "Over-logged",
};

// Money: cents → "$1,234.50". Local (NOT formatDollars, which rounds to whole
// dollars and would hide a $0.50 logged-vs-scheduled difference).
const formatCents = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// Duration in hours from a start/end window, e.g. "1.5 h" / "2 h". The unary
// + strips the trailing zero (+"1.50" → 1, +"1.50"→…): toFixed(2) then +.
const formatDurationHours = (start: Date, end: Date) => {
  const hours = (end.getTime() - start.getTime()) / 3_600_000;
  return `${+hours.toFixed(2)} h`;
};

export function HeldDetailsDialog({
  open,
  onClose,
  logId,
  coachLabel,
  whenLabel,
  onReject,
}: {
  open: boolean;
  onClose: () => void;
  logId: string;
  coachLabel: string;
  whenLabel: string;
  onReject: () => void;
}) {
  const [detail, setDetail] = useState<HeldLogDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [approveError, setApproveError] = useState<string | null>(null);
  const [isLoading, startLoad] = useTransition();
  const [isPending, startApprove] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Lazy fetch on open. Reset any prior state first, then load the detail in a
  // transition and pre-fill the editable times from the LOGGED window.
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDetail(null);
    setLoadError(null);
    setApproveError(null);
    const t = requestAnimationFrame(() => cancelRef.current?.focus());
    startLoad(async () => {
      try {
        const d = await getHeldLogDetail(logId);
        setDetail(d);
        setStartTime(formatPfaTime(d.log.startAt));
        setEndTime(formatPfaTime(d.log.endAt));
      } catch (err) {
        setLoadError(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't load this log's details. Please try again.",
        );
      }
    });
    return () => cancelAnimationFrame(t);
  }, [open, logId]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isPending) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, isPending, onClose]);

  if (!open) return null;

  const log = detail?.log ?? null;
  const block = detail?.block ?? null;

  // Client guard — end strictly after start (server re-validates + ≤16h). Both
  // share the same calendar date, so "HH:MM" string compare is sufficient.
  const timesValid = startTime !== "" && endTime !== "" && endTime > startTime;
  const canApprove = detail !== null && timesValid && !isPending;

  const applyScheduledTime = () => {
    if (!block) return;
    setStartTime(formatPfaTime(block.startAt));
    setEndTime(formatPfaTime(block.endAt));
  };

  const submitApprove = () => {
    if (!log || !timesValid) return;
    const dateStr = formatPfaDate(log.startAt);
    const start = parsePfaInput(dateStr, startTime);
    const end = parsePfaInput(dateStr, endTime);
    // If the chosen times equal the originally-logged times, approve with NO
    // edit (fast path). Otherwise send the corrected ISO window.
    const unchanged =
      startTime === formatPfaTime(log.startAt) &&
      endTime === formatPfaTime(log.endAt);
    setApproveError(null);
    startApprove(async () => {
      try {
        if (unchanged) {
          await approveHeldHourLog(logId);
        } else {
          await approveHeldHourLog(logId, {
            startAt: start.toISOString(),
            endAt: end.toISOString(),
          });
        }
        onClose();
      } catch (err) {
        setApproveError(
          err instanceof Error && err.message
            ? err.message
            : "Couldn't approve this log. Please try again.",
        );
      }
    });
  };

  // Live pay for the CURRENTLY-edited window (mirrors workPayForLog: flat
  // per-session amount, else rate × minutes ÷ 30, rounded). Recomputes as the
  // admin changes the times, so the number they approve is always the number
  // they see — the compare cards above stay fixed as the reference points.
  const editedPayCents: number | null = (() => {
    if (!log || !timesValid) return null;
    if (log.perSessionRateCents !== null) return log.perSessionRateCents;
    if (log.ratePer30MinCents === null) return 0;
    const dateStr = formatPfaDate(log.startAt);
    const minutes =
      (parsePfaInput(dateStr, endTime).getTime() -
        parsePfaInput(dateStr, startTime).getTime()) /
      60_000;
    return Math.round((log.ratePer30MinCents * minutes) / 30);
  })();

  const issueLabel = log?.heldReason
    ? (ISSUE_LABEL[log.heldReason] ?? log.heldReason)
    : null;
  const subtitle = log
    ? `${log.coachName ?? "Unknown coach"} · ${log.programName}`
    : `${coachLabel} · ${whenLabel}`;

  // Difference line: per-session pay is duration-independent (same regardless
  // of time), so both figures match by design → say so. Otherwise show the
  // signed delta of logged vs scheduled pay.
  const renderDifference = () => {
    if (!detail || detail.scheduledPayCents === null) return null;
    if (log && log.perSessionRateCents !== null) {
      return (
        <p className="mt-3 text-xs text-fg-muted">
          Flat per-session pay — same regardless of time.
        </p>
      );
    }
    const delta = detail.loggedPayCents - detail.scheduledPayCents;
    let text: string;
    if (delta > 0) {
      text = `Logged pays ${formatCents(delta)} more than the scheduled block`;
    } else if (delta < 0) {
      text = `Logged pays ${formatCents(-delta)} less than the scheduled block`;
    } else {
      text = "Same pay";
    }
    return <p className="mt-3 text-xs font-medium text-fg">{text}</p>;
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review held work log"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (!isPending) onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl rounded-2xl border border-line bg-surface shadow-[var(--shadow-lg)]"
      >
        <div className="px-5 py-4 border-b border-line">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h4 className="text-base font-semibold text-fg">
                Review held log
              </h4>
              <p className="mt-1 text-xs text-fg-muted leading-relaxed">
                {subtitle}
              </p>
            </div>
            {issueLabel ? (
              <span className="inline-flex shrink-0 items-center rounded-full border border-line-strong bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-fg-muted whitespace-nowrap">
                {issueLabel}
              </span>
            ) : null}
          </div>
        </div>

        {isLoading && !detail ? (
          <div className="px-5 py-10 text-center text-sm text-fg-muted">
            Loading…
          </div>
        ) : loadError ? (
          <div className="px-5 py-8">
            <p className="text-sm text-danger">{loadError}</p>
          </div>
        ) : detail && log ? (
          <>
            <div className="px-5 py-4 space-y-4">
              {/* Side-by-side compare: scheduled block vs coach logged. */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {/* Scheduled block */}
                <div className="rounded-xl border border-line bg-page p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                    Scheduled block
                  </p>
                  {block ? (
                    <div className="mt-2 space-y-1 text-sm">
                      <p className="text-fg">
                        {formatPfaDateMedium(block.startAt)}
                      </p>
                      <p className="text-fg-muted">
                        {formatPfaTime12h(block.startAt)}–
                        {formatPfaTime12h(block.endAt)}
                        <span className="text-fg-subtle">
                          {" · "}
                          {formatDurationHours(block.startAt, block.endAt)}
                        </span>
                      </p>
                      {block.coachNames.length > 0 ? (
                        <p className="text-fg-muted">
                          {block.coachNames.join(", ")}
                        </p>
                      ) : null}
                      {detail.scheduledPayCents !== null ? (
                        <p className="pt-1 text-base font-semibold text-fg tnum">
                          {formatCents(detail.scheduledPayCents)}
                          <span className="ml-1 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                            pay
                          </span>
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-2 text-sm text-fg-muted">
                      No matching scheduled block on the coach&apos;s schedule.
                    </p>
                  )}
                </div>

                {/* Coach logged */}
                <div className="rounded-xl border border-line bg-page p-4">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
                    Coach logged
                  </p>
                  <div className="mt-2 space-y-1 text-sm">
                    <p className="text-fg">
                      {formatPfaDateMedium(log.startAt)}
                    </p>
                    <p className="text-fg-muted">
                      {formatPfaTime12h(log.startAt)}–
                      {formatPfaTime12h(log.endAt)}
                      <span className="text-fg-subtle">
                        {" · "}
                        {formatDurationHours(log.startAt, log.endAt)}
                      </span>
                    </p>
                    {log.note ? (
                      <p className="text-fg-muted">“{log.note}”</p>
                    ) : null}
                    <p className="pt-1 text-base font-semibold text-fg tnum">
                      {formatCents(detail.loggedPayCents)}
                      <span className="ml-1 text-[11px] font-medium uppercase tracking-wider text-fg-subtle">
                        pay
                      </span>
                    </p>
                  </div>
                </div>
              </div>

              {renderDifference()}

              {/* Editable logged times (date read-only — same as the block's
                  date; only the time-of-day is editable). */}
              <div className="border-t border-line pt-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-fg-muted">
                    <span className="uppercase tracking-wider text-fg-subtle">
                      Date
                    </span>{" "}
                    <span className="text-fg">
                      {formatPfaDateMedium(log.startAt)}
                    </span>
                  </div>
                  {block ? (
                    <button
                      type="button"
                      onClick={applyScheduledTime}
                      disabled={isPending}
                      className="inline-flex items-center rounded-lg border border-line-strong bg-surface px-2.5 h-8 text-xs font-medium text-fg-muted hover:text-fg hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition-colors"
                    >
                      Use scheduled time
                    </button>
                  ) : null}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs uppercase tracking-wider text-fg-muted mb-1.5 block">
                      Start
                    </span>
                    <TimeSelect
                      name="heldStart"
                      variant="start"
                      stepMinutes={15}
                      value={startTime}
                      onChange={setStartTime}
                      aria-label="Corrected start time"
                      className="w-full rounded-lg bg-page border border-line text-fg px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs uppercase tracking-wider text-fg-muted mb-1.5 block">
                      End
                    </span>
                    <TimeSelect
                      name="heldEnd"
                      variant="end"
                      stepMinutes={15}
                      value={endTime}
                      onChange={setEndTime}
                      aria-label="Corrected end time"
                      className="w-full rounded-lg bg-page border border-line text-fg px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
                    />
                  </label>
                </div>

                {editedPayCents !== null ? (
                  <p className="mt-3 flex items-baseline gap-1.5 text-sm">
                    <span className="text-fg-muted">Approving pays</span>
                    <span className="font-semibold text-fg tnum">
                      {formatCents(editedPayCents)}
                    </span>
                    {log.perSessionRateCents !== null ? (
                      <span className="text-xs text-fg-subtle">
                        (flat per-session)
                      </span>
                    ) : null}
                  </p>
                ) : null}

                {!timesValid && startTime !== "" && endTime !== "" ? (
                  <p className="mt-3 text-xs text-danger">
                    End must be after start.
                  </p>
                ) : null}
                {approveError ? (
                  <p className="mt-3 text-xs text-danger">{approveError}</p>
                ) : null}
              </div>
            </div>

            <div className="px-5 py-4 border-t border-line flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={onReject}
                disabled={isPending}
                className="inline-flex items-center justify-center rounded-lg border border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 h-9 px-3 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/40 transition-colors"
              >
                Reject
              </button>
              <div className="flex items-center gap-2">
                <button
                  ref={cancelRef}
                  type="button"
                  onClick={onClose}
                  disabled={isPending}
                  className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitApprove}
                  disabled={!canApprove}
                  className="inline-flex items-center justify-center gap-1 rounded-lg h-9 px-3 text-sm font-medium bg-gold text-gold-ink hover:bg-gold-hover shadow-[var(--shadow-sm)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
                >
                  <Check className="h-3.5 w-3.5" />
                  {isPending ? "Approving…" : "Approve"}
                </button>
              </div>
            </div>
          </>
        ) : (
          // Focus target must exist even before the detail resolves so the
          // Esc/focus chrome + backdrop stay consistent.
          <div className="px-5 py-4 border-t border-line flex items-center justify-end">
            <button
              ref={cancelRef}
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg h-9 px-3 text-sm font-medium shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
