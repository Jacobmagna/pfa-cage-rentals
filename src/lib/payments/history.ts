// Paging rules for the "Payment history" list on /admin/payments.
//
// PURE: no DB import, no React. The server page and the client table both
// import it, so every number and every word the list shows about itself is
// decided in one unit-tested place. The matching DB read lives next door in
// history-fetch.ts.
//
// Why the list needs rules at all: it used to stop at 100 rows without saying
// so, and a silently shortened money list reads as "that is everything". The
// list is now paged by a `?shown=` count in the URL and always states how many
// rows it is showing out of how many exist.

/** Rows on a default load, and rows added by each "Show N more" click. */
export const PAYMENT_HISTORY_STEP = 100;

/**
 * Hard ceiling on rows rendered at once. When it is hit the caption says so
 * and names where the older payments live — the list never just stops.
 */
export const PAYMENT_HISTORY_CAP = 2000;

const ROUTE = "/admin/payments";
const DIGITS_ONLY = /^\d+$/;

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Turns the raw `?shown=` search param into a safe row limit.
 *
 * `searchParams` is hostile input, so the page never hands a raw value to
 * `.limit()`:
 *   - an array (`?shown=300&shown=900`) → its first value
 *   - the literal `all`, any casing     → the cap
 *   - anything that is not a plain run of digits ≥ the step ("abc", "", "0",
 *     "-5", "99", "2.5", "1e9", undefined) → the step
 *   - above the cap                     → the cap
 * Non-multiples of the step ("250") are allowed as they are.
 */
export function normalizeShown(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return PAYMENT_HISTORY_STEP;
  if (value.toLowerCase() === "all") return PAYMENT_HISTORY_CAP;
  // Digits only: Number() alone would accept "1e9", "2.5", " 200 " and "0x64".
  if (!DIGITS_ONLY.test(value)) return PAYMENT_HISTORY_STEP;
  const n = Number(value);
  if (n < PAYMENT_HISTORY_STEP) return PAYMENT_HISTORY_STEP;
  // Also covers a digit string long enough to overflow to Infinity.
  if (n > PAYMENT_HISTORY_CAP) return PAYMENT_HISTORY_CAP;
  return n;
}

export type PaymentHistorySummary = {
  /** How many payments exist (never less than the rows in hand). */
  total: number;
  /** How many rows are on screen. */
  visible: number;
  /** True when there are more rows AND the cap still allows showing them. */
  hasMore: boolean;
  /** The `shown` value the "Show N more" button navigates to. */
  nextShown: number;
  /** Payments that exist but are not on screen. */
  remaining: number;
  /** True when the cap, not the data, is what cut the list short. */
  capped: boolean;
  /** The sentence under the heading. Empty when there are no payments. */
  caption: string;
};

/** What the table receives: the summary plus the `shown` it was built for. */
export type PaymentHistoryView = PaymentHistorySummary & { shown: number };

/**
 * Everything the list says about itself, from three numbers.
 *
 * @param shown    the normalized row limit the rows were fetched with
 * @param rowCount how many rows came back
 * @param count    the separate COUNT of all non-deleted payments
 */
export function summarizePaymentHistory({
  shown,
  rowCount,
  count,
}: {
  shown: number;
  rowCount: number;
  count: number;
}): PaymentHistorySummary {
  // The count and the rows are two separate HTTP requests and can straddle a
  // write, so the count may briefly be lower than the rows already in hand.
  // Taking the larger keeps the caption from ever printing "101 of 100".
  const total = Math.max(count, rowCount);
  const visible = rowCount;
  const remaining = total - visible;
  const capped = shown >= PAYMENT_HISTORY_CAP && visible < total;
  const hasMore = visible < total && shown < PAYMENT_HISTORY_CAP;
  const nextShown = Math.min(shown + PAYMENT_HISTORY_STEP, PAYMENT_HISTORY_CAP);

  let caption: string;
  if (total === 0) {
    // The table's own empty state does the talking.
    caption = "";
  } else if (total === 1) {
    caption = "1 payment.";
  } else if (visible === total) {
    caption = `Showing all ${formatCount(total)} payments.`;
  } else if (capped) {
    caption = `Showing the ${formatCount(visible)} most recent of ${formatCount(total)} payments. Older ones are on each coach's page and in Reports → Payments.`;
  } else {
    caption = `Showing the ${formatCount(visible)} most recent of ${formatCount(total)} payments.`;
  }

  return { total, visible, hasMore, nextShown, remaining, capped, caption };
}

/**
 * How many rows one "Show N more" click adds: a full step, or fewer when
 * fewer remain ("Show 43 more") or when the cap is closer than a full step.
 */
export function moreButtonCount({
  visible,
  nextShown,
  remaining,
}: Pick<PaymentHistorySummary, "visible" | "nextShown" | "remaining">): number {
  return Math.max(
    0,
    Math.min(remaining, PAYMENT_HISTORY_STEP, nextShown - visible),
  );
}

export type PaymentHistoryControl = {
  /** The `shown` value this button navigates to. */
  shown: number;
  /** Visible button text. */
  label: string;
  /** Accessible name — spells out "payments" so it stands alone. */
  ariaLabel: string;
};

export type PaymentHistoryControls = {
  more: PaymentHistoryControl;
  all: PaymentHistoryControl;
};

/**
 * The two buttons under the table, or null when there is nothing more to
 * show. Built here so the client component contains no arithmetic.
 */
export function paymentHistoryControls(
  summary: Pick<
    PaymentHistorySummary,
    "total" | "visible" | "hasMore" | "nextShown" | "remaining"
  >,
): PaymentHistoryControls | null {
  if (!summary.hasMore) return null;
  const more = formatCount(moreButtonCount(summary));
  const total = formatCount(summary.total);
  return {
    more: {
      shown: summary.nextShown,
      label: `Show ${more} more`,
      ariaLabel: `Show ${more} more payments`,
    },
    all: {
      // The numeric cap, which is exactly what `?shown=all` normalizes to.
      shown: PAYMENT_HISTORY_CAP,
      label: `Show all (${total})`,
      ariaLabel: `Show all ${total} payments`,
    },
  };
}

/**
 * The URL for a given `shown`. The default stays the bare path, so the
 * canonical URL is clean and inbound links (which pass no params) match it.
 */
export function paymentHistoryHref(shown: number): string {
  return shown === PAYMENT_HISTORY_STEP ? ROUTE : `${ROUTE}?shown=${shown}`;
}
