// ADMIN HOUR ENTRY — the things an admin should be TOLD before hours are
// recorded on a coach's behalf, and the exact words used to tell him.
//
// ── WHY WARNINGS AND NOT REFUSALS ────────────────────────────────────────
// Every case below is one an admin is sometimes right to go ahead with. The
// feature exists precisely because work sometimes goes unrecorded for weeks —
// a coach quits, loses access, or simply never logs — so a guard that refuses
// outright closes the hole it was built to open. Each of these instead stops
// the FIRST submit, states the fact in the admin's own vocabulary, and lets
// him confirm. He is never blocked; he is never surprised either.
//
// ── 🔴 WHY THE OVERLAP CHECK IS NOT OPTIONAL ─────────────────────────────
// `hour_logs_coach_program_start_end_unique` makes an EXACT (coach, program,
// start, end) repeat a true duplicate, and `logHourInternal` handles that
// collision gracefully. It does nothing whatever about a PARTIAL overlap. A
// coach who logged 10:00–3:00 and an admin who records 10:00–2:00 for the same
// day produce two separate payable rows covering the same hours, both correct
// by every constraint in the database, and the coach is paid twice. That is
// the single most expensive mistake this feature makes reachable, and it is
// reachable by an ordinary typo rather than by anything unusual.
//
// The one existing detector for this, `findOverlappingLogIds`, runs on the
// needs-review queue AFTER the fact. Relying on it here would mean routing an
// admin's own entry into an admin's own review queue — the same circularity
// that makes the held-then-approve gate wrong on this path — and it would let
// the money be written first and questioned later.
//
// ── WHY THIS MODULE IS PURE ──────────────────────────────────────────────
// The module that runs the queries imports `@/db` and is reachable only from
// `"use server"` code, so nothing decided there can be unit-tested. Everything
// that DECIDES — which row gets quoted, and the sentence the admin reads —
// lives here, with no DB and no clock. Same constraint that produced
// `@/lib/program-stipend-field`, `@/lib/rate-input` and `@/lib/stipend/scope`.

import { formatPfaDateMedium, formatPfaTime12h } from "@/lib/timezone";

/**
 * How long a submit may sit unanswered before the dialog stops pretending it
 * is still working and says so.
 *
 * 🔴 LIVES HERE, NOT IN THE DIALOG. The dialog is a client component and
 * importing it drags Next and next-auth into any plain node process, so a
 * test could not read the number without duplicating it — and a duplicated
 * threshold drifts the day somebody tunes the real one, leaving a test
 * asserting against a value the product no longer uses. Same reason the
 * wording below lives here rather than in the JSX.
 *
 * Well past a normal round trip (the write plus the schedule sync is a
 * handful of queries) so a merely slow save never trips it.
 */
export const SLOW_SUBMIT_MS = 12_000;

/**
 * One thing the admin is told before the write, with the sentence already
 * built. `kind` is stable so a caller can branch (an icon, a test) without
 * matching on prose.
 *
 * 🔴 `coachId` IS WHAT MAKES THIS SAFE TO SHOW FOR SEVERAL COACHES AT ONCE.
 * One submit can now record the same shift for a whole crew, so a list of
 * warnings can contain two entries of the same `kind` belonging to different
 * people. The message names the coach in prose, but prose is not an
 * identifier: the caller needs a stable key to render the list and a test
 * needs to assert WHOSE warning fired, neither of which can be recovered
 * from a sentence. Without it, React would key two overlapping-log warnings
 * identically and quietly drop one — and the coach whose warning vanished is
 * the one about to be paid twice.
 */
export type AdminHourEntryWarning = {
  kind: "already_paid_through" | "overlapping_log";
  /** The coach this warning is ABOUT — never the admin entering it. */
  coachId: string;
  /** That coach's display name, already resolved (name ?? email). */
  coachLabel: string;
  message: string;
};

/** An existing hour log that overlaps the window being recorded. */
export type OverlappingLog = {
  id: string;
  programName: string;
  startAt: Date;
  endAt: Date;
  /**
   * Held logs are NOT payable and are excluded from every counting read, so
   * they are not a double-pay on their own — but they become one the moment
   * an admin approves them, and an admin recording hours over the top of one
   * is exactly the person who should know it is sitting there.
   */
  status: "posted" | "held";
};

/**
 * Do two half-open intervals overlap? Touching endpoints do NOT — a shift
 * ending at 3:00 and another starting at 3:00 are consecutive, not concurrent.
 *
 * 🔴 The SAME predicate as `findOverlappingLogIds` and `isLogScheduled`,
 * stated once more rather than re-derived, because "do these hours clash?"
 * answered one way at write time and another way by the review queue is how a
 * warning and the report that follows it end up disagreeing in front of Mark.
 */
export function overlapsWindow(
  a: { startAt: Date; endAt: Date },
  b: { startAt: Date; endAt: Date },
): boolean {
  return (
    a.startAt.getTime() < b.endAt.getTime() &&
    a.endAt.getTime() > b.startAt.getTime()
  );
}

/**
 * Every existing log of this coach's that clashes with the window being
 * recorded, quoted most-recent-first so the message names the nearest one.
 *
 * ⚠️ Program is deliberately IGNORED, matching `findOverlappingLogIds`: a
 * coach cannot be in two places at once regardless of which program each log
 * names, and the double-pay is just as real across two programs as within one.
 */
export function findOverlappingLogs(
  window: { startAt: Date; endAt: Date },
  existing: readonly OverlappingLog[],
): OverlappingLog[] {
  return existing
    .filter((log) => overlapsWindow(window, log))
    .sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
}

/**
 * The sentence naming an overlap. Quotes ONE log in full — program, date and
 * both times — because a warning an admin cannot act on without opening
 * another screen is a warning he dismisses. Extra clashes are counted, not
 * listed: the count is what tells him this is not a single stray row.
 *
 * Callers must not pass an empty array; there is no such thing as an overlap
 * warning with nothing to name.
 */
export function overlappingLogMessage(
  coachLabel: string,
  overlaps: readonly OverlappingLog[],
): string {
  const first = overlaps[0];
  if (!first) {
    throw new Error("overlappingLogMessage called with no overlapping logs");
  }
  const when =
    `${formatPfaDateMedium(first.startAt)}, ` +
    `${formatPfaTime12h(first.startAt)} – ${formatPfaTime12h(first.endAt)}`;
  const held =
    first.status === "held"
      ? " (held, waiting for approval — it becomes payable the moment it is approved)"
      : "";
  const others =
    overlaps.length > 1
      ? ` ${overlaps.length - 1} further ${
          overlaps.length === 2 ? "entry overlaps" : "entries overlap"
        } this window too.`
      : "";

  return (
    `These hours overlap one already recorded for ${coachLabel}: ` +
    `${first.programName}, ${when}${held}. Recording both pays ${coachLabel} ` +
    `for the same time twice.${others}`
  );
}
