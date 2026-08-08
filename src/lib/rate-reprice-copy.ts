// SPEC rate-effective-dating §6 + §7 — EVERY WORD MARK READS about a
// retroactive re-price, as pure functions.
//
// ── Why the copy is a module and not JSX ─────────────────────────────────
// Two reasons, and the second is the real one.
//
//  1. The unit suite runs in `environment: "node"` with no jsdom and no
//     testing-library (see vitest.config.ts). Sentences that live in a
//     component are untestable here; sentences that live in a pure function
//     are exhaustively testable, including the pluralization, the sign, the
//     empty case and the excluded-coach list.
//  2. Mark has already been burned once by a rate model he misread — he
//     entered a per-game fee as an hourly rate and coaches were paid 2–4× for
//     months. So the wording is a SAFETY CONTROL, not decoration. Putting it
//     under test, in one place, is how it stops drifting between the two rate
//     surfaces that both render it.
//
// ── Rules these strings follow ───────────────────────────────────────────
//   • Never abbreviate money. "$1,240.00", not "$1.2k" and not "1240".
//   • Always say the direction in words as well as sign — "lowers pay", not
//     just a red minus.
//   • Always name people. A count of affected coaches is not enough; §6 is
//     explicit that the warning names who loses what and that the exclusion
//     list is by name.
//   • Say what will NOT happen, not only what will. The excluded-coaches line
//     is the reassurance that Mark's per-coach work is safe.
//
// Type-only imports from @/lib/server/rate-reprice, which pulls in @/db.
// `isolatedModules` erases them at build time, so this module stays safe to
// import from a client component — the same property src/lib/errors.ts
// depends on and documents.

import type {
  RateRepricePreview,
  RepriceCoachDelta,
  RepriceLogDiff,
} from "@/lib/server/rate-reprice";
import { PFA_TIMEZONE } from "@/lib/timezone";

// ─────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────

/** U+2212 MINUS SIGN. Visually unambiguous next to a dollar amount in a way
 *  the ASCII hyphen is not — "-$475" reads as a dash to a hurried eye. */
export const MINUS = "−";

/** `124000` → `"$1,240.00"`. Never abbreviated, always two decimals. */
export function formatMoneyCents(cents: number): string {
  const negative = cents < 0;
  const whole = Math.abs(cents) / 100;
  const body = whole.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return negative ? `${MINUS}${body}` : body;
}

/** `44000` → `"+$440.00"`, `-47500` → `"−$475.00"`, `0` → `"$0.00"`. */
export function formatSignedMoneyCents(cents: number): string {
  if (cents > 0) return `+${formatMoneyCents(cents)}`;
  return formatMoneyCents(cents);
}

/**
 * THE HEADLINE SET — the rows whose PAY actually moves.
 *
 * `rate_source_kind` shipped nullable with no backfill, so on the first
 * production run every pre-existing `hour_logs` row has a NULL provenance, the
 * engine's `IS DISTINCT FROM` check fires on provenance alone, and every
 * in-window log lands in `changed` with `deltaCents = 0`. Those rows are still
 * written — provenance has to stop lying — but the number Mark confirms has to
 * be the number of entries that move money, or the very first prod run reports
 * "214 entries" for a change that moves 6.
 *
 * The DELTA is identical to `preview.totalDeltaCents` either way, because
 * every row this drops moves $0. The old/new subtotals become the subtotals of
 * the rows actually named in the sentence, which is the only way "6 entries.
 * Pay $A → $B" is a true statement about one set of rows.
 *
 * The `??` fallback is the same defensiveness `formatRepriceRange` documents:
 * a preview crosses the server-action boundary before it reaches the component
 * that renders this, and a missing field must degrade to the pre-existing
 * behavior, never to zero on a payroll screen.
 */
function repricedForHeadline(preview: RateRepricePreview): {
  logCount: number;
  oldTotalPayCents: number;
  newTotalPayCents: number;
  totalDeltaCents: number;
  logs: RepriceLogDiff[];
} {
  const bucket = preview.payChanged;
  if (bucket) {
    return {
      logCount: bucket.logCount,
      oldTotalPayCents: bucket.oldTotalPayCents,
      newTotalPayCents: bucket.newTotalPayCents,
      totalDeltaCents: bucket.totalDeltaCents,
      logs: bucket.logs ?? [],
    };
  }
  return {
    logCount: preview.changedLogCount,
    oldTotalPayCents: preview.oldTotalPayCents,
    newTotalPayCents: preview.newTotalPayCents,
    totalDeltaCents: preview.totalDeltaCents,
    logs: preview.logs ?? [],
  };
}

/**
 * "entry" / "entries", never "log". Mark's surface calls these things logged
 * hours, but a per-session log is not an hour, so "entry" is the one word
 * that is true for both pay modes.
 */
export function pluralEntries(n: number): string {
  return `${n} ${n === 1 ? "entry" : "entries"}`;
}

/** "Jun 19" in PFA time. Year appended only when it is not the current one. */
export function formatShortDate(d: Date, now: Date = new Date()): string {
  const sameYear =
    d.toLocaleDateString("en-US", { timeZone: PFA_TIMEZONE, year: "numeric" }) ===
    now.toLocaleDateString("en-US", { timeZone: PFA_TIMEZONE, year: "numeric" });
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * "Jun 19 – Aug 7" over the logs that would actually change. Collapses to a
 * single date when every affected entry falls on one day, so the summary
 * never says "Aug 7 – Aug 7".
 */
export function formatRepriceRange(
  preview: RateRepricePreview,
  now: Date = new Date(),
): string | null {
  // `?? []` is not paranoia for its own sake: a preview crosses the server-
  // action boundary before it reaches the component that renders this, and a
  // missing array must degrade to "no range shown", never to a client crash
  // sitting on top of a payroll decision.
  //
  // The range covers the rows the HEADLINE counts — the ones whose pay moves
  // — so "14 entries from Jun 19 – Aug 7" is one consistent statement rather
  // than a count of one set over the dates of another.
  const logs = repricedForHeadline(preview).logs;
  if (logs.length === 0) return null;
  let min = logs[0].startAt;
  let max = logs[0].startAt;
  for (const l of logs) {
    if (l.startAt.getTime() < min.getTime()) min = l.startAt;
    if (l.startAt.getTime() > max.getTime()) max = l.startAt;
  }
  const from = formatShortDate(min, now);
  const to = formatShortDate(max, now);
  return from === to ? from : `${from} – ${to}`;
}

/** "$30.00 / hr" — hourly cents are stored PER 30 MIN, so ×2 to display. */
export function formatHourlyRateLabel(centsPer30Min: number): string {
  return `${formatMoneyCents(centsPer30Min * 2)} / hr`;
}

/** "$100.00 / session" — FLAT. Never doubled, never halved (bug class 0052). */
export function formatPerSessionRateLabel(cents: number): string {
  return `${formatMoneyCents(cents)} / session`;
}

/** The rate label for whichever mode is in play, or the honest "no rate". */
export function formatRateLabel(args: {
  payMode: "hourly" | "per_session";
  ratePer30MinCents: number | null | undefined;
  perSessionRateCents: number | null | undefined;
}): string {
  if (args.payMode === "per_session") {
    return args.perSessionRateCents != null
      ? formatPerSessionRateLabel(args.perSessionRateCents)
      : "No per-session amount set";
  }
  return args.ratePer30MinCents != null
    ? formatHourlyRateLabel(args.ratePer30MinCents)
    : "No rate set";
}

// ─────────────────────────────────────────────────────────────────────────
// The date picker's cap (SPEC §3 / decision §10.1 — no future dating)
// ─────────────────────────────────────────────────────────────────────────

/** "2026-08-07" in PFA time — the `max` attribute for the date input. */
export function maxEffectiveDate(now: Date = new Date()): string {
  // Explicit parts rather than a locale short-format, for the reason
  // formatPfaDate documents: some browsers ignore "en-CA" and fall back to
  // US M/D/YYYY, which would poison the <input type="date"> max attribute.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PFA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * TRUE when a "YYYY-MM-DD" picked in the date input is after today in PFA
 * time. The `max` attribute is a hint a keyboard user can type straight past,
 * so the control checks this itself; the schema and the engine each check it
 * again server-side (SPEC §3 — three independent gates, none of them the UI
 * alone).
 */
export function isFutureEffectiveDate(
  value: string,
  now: Date = new Date(),
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return value > maxEffectiveDate(now);
}

export const FUTURE_DATE_MESSAGE =
  "Pick today or a date in the past — a rate can't start in the future.";

// ─────────────────────────────────────────────────────────────────────────
// The mode helper text (SPEC §7)
// ─────────────────────────────────────────────────────────────────────────

export type EffectiveMode = "forward" | "back";

/** One sentence under the chosen option, so the default is never a mystery. */
export function describeEffectiveMode(
  mode: EffectiveMode,
  dateValue: string,
  now: Date = new Date(),
): string {
  if (mode === "forward") {
    return "The new rate applies to hours logged from now on. Nothing already logged changes.";
  }
  if (!dateValue) {
    return "Pick the date this rate should have started. Hours already logged from that date forward will be re-priced.";
  }
  if (isFutureEffectiveDate(dateValue, now)) return FUTURE_DATE_MESSAGE;
  const [y, m, d] = dateValue.split("-").map(Number);
  // Noon UTC keeps the label on the intended calendar day in PFA time no
  // matter the DST offset; this Date is for DISPLAY only — the submitted
  // value stays the "YYYY-MM-DD" string the server converts with
  // pfaWallClockToUtc.
  const label = formatShortDate(new Date(Date.UTC(y, m - 1, d, 12)), now);
  return `Hours already logged from ${label} forward will be re-priced at this rate.`;
}

// ─────────────────────────────────────────────────────────────────────────
// The preview summary (SPEC §6 "preview before commit")
// ─────────────────────────────────────────────────────────────────────────

export type RepriceDecreaseWarning = {
  /** "This lowers pay on hours already logged." */
  headline: string;
  /** ["Mitchell Torres −$475.00", "Cole Parker −$300.00"] */
  coachLines: string[];
  /** The "we can't claw it back" sentence. PFA has no payout ledger. */
  reassurance: string;
  /** The label on the deliberate second confirmation. */
  acknowledgeLabel: string;
  byCoach: RepriceCoachDelta[];
  totalDeltaCents: number;
};

/**
 * One run of the headline. `nowrap` segments must render with
 * `white-space: nowrap`.
 *
 * The signed delta is the reason this exists. The direction of a retro is
 * carried by a U+2212 MINUS SIGN chosen precisely because it is unmistakable
 * next to a dollar amount — and a line break between the sign and the amount
 * ("… → $240.00 (−" / "$120.00).") throws that away, leaving a cut looking
 * like a raise at exactly the moment it matters. `headline` is still the whole
 * sentence, unchanged, for tests and for anything reading it as plain text.
 */
export type RepriceHeadlinePart = { text: string; nowrap?: boolean };

export type RepricePreviewSummary = {
  /** `true` when at least one already-logged entry's PAY would move. */
  hasChanges: boolean;
  /** The one-line dollar answer Mark confirms. */
  headline: string;
  /** The same sentence, segmented so the signed delta cannot break across lines. */
  headlineParts: RepriceHeadlinePart[];
  /**
   * Which way the money moves. The sign alone is not enough: a raise and a cut
   * render the same shape, and the red decrease block that carries the
   * difference can fall below the fold on a tall card.
   */
  direction: "increase" | "decrease" | "none";
  /** SPEC §6 — who this CANNOT reach, by name. Null when nobody is excluded. */
  excludedLine: string | null;
  /**
   * Rows written for PROVENANCE only — no pay change. Kept OUT of the headline
   * and stated separately, or the first prod run claims to be re-pricing every
   * log in the window. Null when there are none.
   */
  provenanceLine: string | null;
  /**
   * SPEC §6 — held entries in this window were skipped, and approving one
   * later posts it at its ORIGINAL stamp. Null when there are none.
   */
  heldLine: string | null;
  /** Null unless something goes DOWN. Presence = Save must be double-gated. */
  decrease: RepriceDecreaseWarning | null;
};

/**
 * SPEC §6 — held logs are never re-priced (they are not payable yet), and
 * `approveHeldHourLogInternal` only flips the status: it does not re-resolve
 * the rate. So a held entry approved after a retro posts at whatever it was
 * stamped with — usually $0, which is the exact bug this feature exists to
 * fix. This line is the signal. It changes no dollar; it tells Mark to re-run.
 */
export function buildHeldLine(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) {
    return "1 entry in this range is held and wasn't re-priced (it's awaiting approval). Re-run this after approving it.";
  }
  return `${count} entries in this range are held and weren't re-priced (they're awaiting approval). Re-run this after approving them.`;
}

/**
 * The provenance-only rows, said plainly and kept away from the money. "No pay
 * change" is the whole point of the sentence.
 */
export function buildProvenanceLine(count: number): string | null {
  if (count <= 0) return null;
  if (count === 1) {
    return "1 more entry gets a record-keeping fix (noting where its rate came from). No pay change.";
  }
  return `${count} more entries get a record-keeping fix (noting where their rates came from). No pay change.`;
}

/**
 * SPEC §6 — the coaches a PROGRAM-DEFAULT retro structurally cannot reach,
 * named. Showing what it will NOT touch is as important as what it will: it
 * is the proof that Mark's per-coach rate work is safe.
 *
 * Always null for an override-scoped retro, where the concept does not apply
 * (the scope is one coach, and nobody else is "excluded" — they simply aren't
 * involved).
 */
export function buildExcludedLine(preview: RateRepricePreview): string | null {
  const names = preview.excludedCoaches.map((c) => c.coachName);
  if (names.length === 0) return null;
  return `Not affected: ${formatNameList(names)} (they have their own rate on this program).`;
}

/** "A", "A and B", "A, B and C" — an Oxford-free serial list of names. */
export function formatNameList(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * 🔴 SPEC §6 — the hard-stop warning. Returns null when nothing goes down.
 *
 * The last sentence is the one that matters most and is the reason this is
 * not generic "are you sure" copy: PFA has NO payout ledger (exactly one
 * `coach_payments` row facility-wide) and Mark pays coaches outside the app.
 * So lowering a past rate does not reclaim a dollar — it only rewrites what
 * the app believes it still owes. Mark has to know that before he confirms,
 * or he will read a decrease as "money recovered".
 */
export function buildDecreaseWarning(
  preview: RateRepricePreview,
): RepriceDecreaseWarning | null {
  const bucket = preview.decreases;
  if (bucket.logCount === 0) return null;
  return {
    headline: "This lowers pay on hours already logged.",
    coachLines: bucket.byCoach.map(
      (c) => `${c.coachName} ${formatMoneyCents(c.deltaCents)}`,
    ),
    reassurance:
      "If they have already been paid, this will not take that money back — it only changes what the app says they are owed.",
    acknowledgeLabel:
      "I understand this lowers already-logged pay. Apply it anyway.",
    byCoach: bucket.byCoach,
    totalDeltaCents: bucket.totalDeltaCents,
  };
}

/**
 * 🔴 What the banner says when the SERVER refused the save
 * (RateRepriceDecreaseNotConfirmedError).
 *
 * Deliberately an instruction, not an apology: the refusal is the guard
 * working, and the admin needs the next three steps, not a status code. The
 * numbers themselves are NOT repeated here — the refusal carries the diff the
 * server computed, and that gets rendered as the full named-coach warning
 * right below this line.
 *
 * ⚠️ THE SECOND SENTENCE IS NOT REASSURANCE, IT IS A FACT THE ADMIN NEEDS.
 * Both save paths persist the rate BEFORE the guard can throw, and that is
 * deliberate: the engine re-resolves from persisted state, so the rate must
 * already be there (see the "ORDER IS NOT NEGOTIABLE" header in
 * src/lib/server/rate-effective-dating-actions.ts). "Tick the box, then save
 * again" alone reads as "nothing was saved" — so an admin who hits Cancel
 * instead walks away believing the old rate is still live going forward, when
 * the new one already is. Only the retro half was held.
 */
export const DECREASE_REFUSED_MESSAGE =
  "This would lower pay on hours already logged. Review who loses what below, tick the box, then save again. " +
  "The new rate is already saved and applies to hours logged from now on — only the change to hours already logged was held.";

/**
 * The whole §6 preview, as words. `now` is injectable so the tests are not
 * hostage to the calendar.
 */
export function buildRepricePreviewSummary(
  preview: RateRepricePreview,
  now: Date = new Date(),
): RepricePreviewSummary {
  const excludedLine = buildExcludedLine(preview);
  const decrease = buildDecreaseWarning(preview);
  const from = formatShortDate(preview.effectiveFrom, now);
  const heldLine = buildHeldLine(preview.heldLogCount ?? 0);
  const provenanceLine = buildProvenanceLine(preview.provenanceOnlyLogCount ?? 0);
  const moved = repricedForHeadline(preview);

  if (moved.logCount === 0) {
    // Two genuinely different "nothing happens" cases, and conflating them
    // would be a small lie either way: "no entries exist back there" is not
    // the same fact as "they already pay this".
    //
    // The second branch is now REACHABLE ON A FIRST RUN. It could not be
    // before: with `rate_source_kind` un-backfilled, every in-window log
    // landed in `changed`, so `changedLogCount` was never 0 and this said
    // "re-pricing 214 entries (+$0.00)" instead of "nothing moves".
    const headline =
      preview.scannedLogCount === 0
        ? `Nothing to re-price. No logged entries on or after ${from}.`
        : `No change. All ${pluralEntries(
            preview.scannedLogCount,
          )} from ${from} onward already pay this rate.`;
    return {
      hasChanges: false,
      headline,
      headlineParts: [{ text: headline }],
      direction: "none",
      excludedLine,
      provenanceLine,
      heldLine,
      decrease: null,
    };
  }

  const range = formatRepriceRange(preview, now) ?? from;
  // Split so the signed delta — the one token that says which WAY the money
  // moves — can be held on a single line by the renderer. Joining the parts
  // reproduces the sentence character for character.
  const headlineParts: RepriceHeadlinePart[] = [
    {
      text:
        `Re-pricing ${pluralEntries(moved.logCount)} from ${range}. ` +
        `Pay ${formatMoneyCents(moved.oldTotalPayCents)} → ` +
        `${formatMoneyCents(moved.newTotalPayCents)} `,
    },
    { text: `(${formatSignedMoneyCents(moved.totalDeltaCents)}).`, nowrap: true },
  ];

  return {
    hasChanges: true,
    headline: headlineParts.map((p) => p.text).join(""),
    headlineParts,
    direction:
      moved.totalDeltaCents > 0
        ? "increase"
        : moved.totalDeltaCents < 0
          ? "decrease"
          : "none",
    excludedLine,
    provenanceLine,
    heldLine,
    decrease,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// After the fact
// ─────────────────────────────────────────────────────────────────────────

/** What the toast/banner says once a re-price has actually been applied. */
export function buildRepriceAppliedMessage(
  preview: RateRepricePreview,
  now: Date = new Date(),
): string {
  // Same held nudge as the preview: a held entry approved after this posts at
  // its ORIGINAL stamp, so the result screen is the last place to say so.
  const held = buildHeldLine(preview.heldLogCount ?? 0);
  const tail = held ? ` ${held}` : "";
  const moved = repricedForHeadline(preview);
  if (moved.logCount === 0) {
    return `Rate saved. Nothing already logged needed re-pricing.${tail}`;
  }
  const range = formatRepriceRange(preview, now);
  return (
    `Rate saved and ${pluralEntries(moved.logCount)} re-priced` +
    `${range ? ` (${range})` : ""}. ` +
    `Pay ${formatMoneyCents(moved.oldTotalPayCents)} → ` +
    `${formatMoneyCents(moved.newTotalPayCents)} ` +
    `(${formatSignedMoneyCents(moved.totalDeltaCents)}).${tail}`
  );
}
