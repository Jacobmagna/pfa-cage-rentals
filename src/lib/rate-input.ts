// SPEC rate-effective-dating Phase D2 — the ONE place a typed dollar string
// becomes integer cents.
//
// ── Why this module exists ───────────────────────────────────────────────
// These four parsers already existed, VERBATIM DUPLICATED, inside two
// "use server" form-action files. That was fine while only the server ever
// converted dollars → cents. Phase D2 breaks that assumption: the inline
// preview (SPEC §7) has to send the engine the CANDIDATE rate the admin has
// typed but not yet saved, and it sends it FROM THE BROWSER — so the client
// now converts the same string the server will convert a moment later.
//
// Two implementations of that conversion is the exact shape of the bug this
// whole feature exists to prevent: the preview quotes one number and the save
// writes another. So the parsers move here, are imported by both sides, and
// are unit-tested. A "use server" module cannot be imported by a client
// component (every export becomes an RPC endpoint), which is why the shared
// home is a plain module and not one of the form-action files.
//
// ── The halving rule (bug class 0052) ────────────────────────────────────
// HOURLY rates are TYPED PER HOUR and STORED PER 30 MIN, so they are HALVED.
// PER-SESSION amounts are FLAT — a fee for one logged session however long it
// ran — so they are NEVER halved. Mixing the two up is precisely how a
// per-game fee got entered as an hourly rate and paid 2–4× for months. The
// two are separate exported functions with separate names for that reason;
// there is no shared "toCents" with a boolean.
//
// Zero behavior change from the copies these replace: same regex, same
// bounds, same thrown messages, character for character.

/** 2-decimal precision, optional leading "$", digits only. */
const DOLLARS_RE = /^\d+(\.\d{1,2})?$/;

function clean(input: string): string {
  return input.trim().replace(/^\$/, "").trim();
}

/**
 * A REQUIRED rate typed PER 30 MIN → cents. Used for cage/bullpen rental
 * rates and for per-session flat amounts (both are already in their storage
 * unit, so there is no ×2 or ÷2 anywhere in here).
 *
 * Throws a friendly `Error` — the form-action layer surfaces `err.message`
 * straight into the banner.
 */
export function dollarsToCents(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Rate is required");
  // Allow optional leading $ for paste-from-spreadsheet convenience.
  const cleaned = clean(trimmed);
  if (!DOLLARS_RE.test(cleaned)) {
    throw new Error("Rate must be a positive dollar amount (e.g. 22 or 22.50)");
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat <= 0) {
    throw new Error("Rate must be greater than $0");
  }
  // Multiply BEFORE rounding to dodge float-drift edge cases at
  // exactly half-cent boundaries.
  return Math.round(asFloat * 100);
}

/**
 * A REQUIRED rate typed PER HOUR → cents PER 30 MIN (the storage unit).
 * HALVED. Work/program rates are entered per hour everywhere in the admin UI.
 */
export function hourlyDollarsToCentsPer30Min(input: string): number {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Rate is required");
  const cleaned = clean(trimmed);
  if (!DOLLARS_RE.test(cleaned)) {
    throw new Error("Rate must be a positive dollar amount (e.g. 44 or 44.50)");
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat <= 0) {
    throw new Error("Rate must be greater than $0");
  }
  // Entered per HOUR → stored per 30 min (half).
  return Math.round((asFloat * 100) / 2);
}

/**
 * An OPTIONAL rate typed PER HOUR → cents PER 30 MIN. Blank → null ("no rate
 * set"), which is a legal state for a program default. HALVED, like its
 * required sibling. Accepts 0 (an explicitly free program) where the required
 * parsers reject it.
 */
export function optionalHourlyDollarsToCentsPer30Min(
  input: string,
): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const cleaned = clean(trimmed);
  if (!DOLLARS_RE.test(cleaned)) {
    throw new Error(
      "Pay rate must be a positive dollar amount (e.g. 44 or 44.50)",
    );
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat < 0) {
    throw new Error("Pay rate must be a positive dollar amount");
  }
  // Entered per HOUR → stored per 30 min (half).
  return Math.round((asFloat * 100) / 2);
}

/**
 * An OPTIONAL FLAT per-session amount → cents. Blank → null.
 *
 * ⚠️ Deliberately NOT halved. $100 stores as 10000, not 5000. See the header.
 */
export function optionalSessionDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const cleaned = clean(trimmed);
  if (!DOLLARS_RE.test(cleaned)) {
    throw new Error(
      "Per-session amount must be a positive dollar amount (e.g. 100 or 100.50)",
    );
  }
  const asFloat = Number(cleaned);
  if (!Number.isFinite(asFloat) || asFloat < 0) {
    throw new Error("Per-session amount must be a positive dollar amount");
  }
  return Math.round(asFloat * 100);
}

// ─────────────────────────────────────────────────────────────────────────
// SOFT variants — for the live inline preview only
// ─────────────────────────────────────────────────────────────────────────
//
// The preview re-runs on every keystroke, and a half-typed "4." is not an
// error the admin should be shouted at for — it is just "no preview yet".
// These return null instead of throwing. They call the STRICT parser above
// rather than re-deriving anything, so a value the preview accepts is always
// a value the save would accept too, and priced identically.

function soft(fn: () => number | null): number | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** Per-HOUR string → per-30-min cents, or null if not (yet) valid. */
export function tryHourlyDollarsToCentsPer30Min(input: string): number | null {
  return soft(() => hourlyDollarsToCentsPer30Min(input));
}

/** Flat per-session string → cents, or null if not (yet) valid. */
export function tryFlatDollarsToCents(input: string): number | null {
  return soft(() => dollarsToCents(input));
}

/** Optional per-HOUR string → per-30-min cents; blank → null; invalid → null. */
export function tryOptionalHourlyDollarsToCentsPer30Min(
  input: string,
): number | null {
  return soft(() => optionalHourlyDollarsToCentsPer30Min(input));
}
