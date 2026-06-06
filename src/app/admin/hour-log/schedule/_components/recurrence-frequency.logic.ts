// Pure helpers for the program-block dialog's recurrence FREQUENCY control
// (QA10 W3.1b). No DOM, no `new Date()` "now", no viewer-timezone date
// parsing — the monthly weekday/ordinal is derived from the YYYY-MM-DD
// calendar parts via UTC math so it matches the pure generator
// (schedule-recurrence.ts, which uses Date.UTC(...).getUTCDay + the same
// ordinal = ceil(dayOfMonth / 7) convention) and never drifts with the
// runtime timezone.

// The four recurrence patterns the admin can pick. The select submits one
// of these `kind`s; `freqIntervalForKind` maps it (plus the typed N for
// "everyN") to the (frequency, interval) the series schema/action expects.
export type FrequencyKind = "weekly" | "biweekly" | "everyN" | "monthly";

export const FREQUENCY_OPTIONS: { value: FrequencyKind; label: string }[] = [
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every other week" },
  { value: "everyN", label: "Every N weeks" },
  { value: "monthly", label: "Monthly (same weekday)" },
];

// Map a chosen UI pattern → the (frequency, interval) the zod
// create/edit-series schema + generator understand:
//   - "weekly"   → weekly, interval 1   (DEFAULT — identical to today)
//   - "biweekly" → weekly, interval 2
//   - "everyN"   → weekly, interval N   (N from the number input, clamped ≥ 1)
//   - "monthly"  → monthly, interval 1  (same weekday/ordinal each month)
export function freqIntervalForKind(
  kind: FrequencyKind,
  everyNWeeks: number,
): { frequency: "weekly" | "monthly"; interval: number } {
  switch (kind) {
    case "weekly":
      return { frequency: "weekly", interval: 1 };
    case "biweekly":
      return { frequency: "weekly", interval: 2 };
    case "everyN": {
      const n = Number.isFinite(everyNWeeks) ? Math.floor(everyNWeeks) : 1;
      return { frequency: "weekly", interval: n >= 1 ? n : 1 };
    }
    case "monthly":
      return { frequency: "monthly", interval: 1 };
  }
}

// Recover the UI pattern from a stored (frequency, interval) so the
// edit-series form opens on the series' current pattern. weekly/1 →
// "weekly"; weekly/2 → "biweekly"; weekly/N (N≥3) → "everyN"; monthly/* →
// "monthly".
export function kindForFreqInterval(
  frequency: "weekly" | "monthly",
  interval: number,
): FrequencyKind {
  if (frequency === "monthly") return "monthly";
  if (interval <= 1) return "weekly";
  if (interval === 2) return "biweekly";
  return "everyN";
}

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const ORDINAL_WORDS = ["1st", "2nd", "3rd", "4th", "5th"] as const;

// PFA-local weekday (0=Sun..6=Sat) of a "YYYY-MM-DD" date, derived from
// the calendar parts via Date.UTC (getUTCDay) so it never shifts with the
// runtime TZ — same convention as the generator. Returns null for a
// malformed/empty ISO.
export function weekdayFromIso(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map((p) => Number(p));
  const probe = new Date(Date.UTC(y, m - 1, d));
  // Reject impossible dates (e.g. 2026-02-30) by round-tripping.
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return probe.getUTCDay();
}

// Human label for the monthly same-weekday occurrence implied by a start
// date, e.g. "2nd Tuesday". ordinal = ceil(dayOfMonth / 7) (1st..5th) and
// the weekday name both come from the YYYY-MM-DD parts — matching the
// generator's monthly expander. Returns "" for a malformed/empty ISO.
export function monthlyWeekdayLabel(startDateIso: string): string {
  const weekday = weekdayFromIso(startDateIso);
  if (weekday === null) return "";
  const day = Number(startDateIso.split("-")[2]);
  const ordinal = Math.ceil(day / 7); // 1..5
  const word = ORDINAL_WORDS[ordinal - 1];
  if (!word) return "";
  return `${word} ${WEEKDAY_NAMES[weekday]}`;
}

// Full hint shown under the frequency control for the monthly pattern,
// e.g. "On the 2nd Tuesday of each month". Empty string when the start
// date isn't a valid ISO yet (so the caller can hide the hint).
export function monthlyHint(startDateIso: string): string {
  const label = monthlyWeekdayLabel(startDateIso);
  return label ? `On the ${label} of each month` : "";
}
