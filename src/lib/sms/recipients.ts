// 1b #25 — PURE recipient-selection + phone-normalization helpers for the
// nightly SMS reminder. No DB / no `new Date()` here: the server layer
// (src/lib/server/sms-reminders.ts) fetches the rows and passes them in, so
// this stays deterministically unit-testable.
//
// The "who had scheduled work yesterday they didn't log" derivation REUSES
// `isLogScheduled` (src/lib/coach-hour-log.ts) — the same program + half-open
// time-overlap match the no-show queue uses — scoped by the caller to a
// single Pacific calendar day and deduped to one entry per coach.

import { isLogScheduled } from "@/lib/coach-hour-log";

// A scheduled (block, coach) pair for the target day. One row per coach per
// block they're a member of — exactly the shape needed_review uses.
export type ReminderCandidate = {
  blockId: string;
  coachId: string;
  programId: string;
  startMs: number;
  endMs: number;
};

// A POSTED hour-log used to decide whether a candidate block was logged.
// (Held logs are excluded upstream in the query, mirroring needs-review.)
export type ReminderLog = {
  coachId: string;
  programId: string;
  startMs: number;
  endMs: number;
};

// A coach eligible to be texted: opted in, not opted out, with a phone that
// normalized to E.164. `phone` is already-normalized E.164.
export type EligibleCoach = {
  coachId: string;
  name: string | null;
  phone: string;
};

export type Recipient = {
  coachId: string;
  name: string | null;
  phone: string;
};

/**
 * Normalize a raw phone string to E.164 (US default), or return null if it
 * can't be made into a plausible number. PURE.
 *
 * Rules (deliberately conservative — we'd rather skip a junk number than
 * text a wrong one):
 *   • Strip everything except digits and a single leading '+'.
 *   • A leading '+' is honored: "+<digits>" with 8–15 digits → "+<digits>".
 *   • 10 bare digits → assume US, prefix "+1".
 *   • 11 bare digits starting with "1" → US, prefix "+".
 *   • Anything else (too short, too long, all-zeros, letters-only) → null.
 */
export function normalizeUsPhoneE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;

  if (hasPlus) {
    // International form already. E.164 allows up to 15 digits, min ~8.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }

  if (digits.length === 10) {
    // Bare US number → +1.
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return null;
}

/**
 * Given the candidate (block, coach) pairs for the target day, the posted
 * logs for those coaches, and the set of eligible coaches (opted in + valid
 * phone), return the DEDUPED list of coaches to text — one entry per coach
 * who had at least one scheduled block they did NOT log.
 *
 * A block counts as "logged" when the coach has any posted log matching it
 * (same program + half-open time overlap, via isLogScheduled). A coach is
 * texted only if at least one of their candidate blocks is unlogged AND they
 * are eligible. PURE.
 */
export function selectRecipients(args: {
  candidates: ReminderCandidate[];
  logs: ReminderLog[];
  eligible: EligibleCoach[];
}): Recipient[] {
  const { candidates, logs, eligible } = args;

  const eligibleByCoach = new Map<string, EligibleCoach>();
  for (const c of eligible) eligibleByCoach.set(c.coachId, c);

  // Logs grouped by coach for isLogScheduled.
  const logsByCoach = new Map<
    string,
    { programId: string; startMs: number; endMs: number }[]
  >();
  for (const log of logs) {
    const list = logsByCoach.get(log.coachId) ?? [];
    list.push({
      programId: log.programId,
      startMs: log.startMs,
      endMs: log.endMs,
    });
    logsByCoach.set(log.coachId, list);
  }

  // A coach makes the list the first time we see an unlogged candidate of
  // theirs. Dedup by coachId.
  const toText = new Map<string, Recipient>();
  for (const c of candidates) {
    if (toText.has(c.coachId)) continue; // already queued this coach
    const coach = eligibleByCoach.get(c.coachId);
    if (!coach) continue; // not opted in / no valid phone

    const logged = isLogScheduled(
      { programId: c.programId, startMs: c.startMs, endMs: c.endMs },
      logsByCoach.get(c.coachId) ?? [],
    );
    if (logged) continue; // this block was logged — not a reminder reason

    toText.set(c.coachId, {
      coachId: c.coachId,
      name: coach.name,
      phone: coach.phone,
    });
  }

  return [...toText.values()];
}
