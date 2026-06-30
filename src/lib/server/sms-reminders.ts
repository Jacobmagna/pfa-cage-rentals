// 1b #25 — the nightly SMS work-log reminder orchestrator. The ONLY callers
// are the /api/cron/sms-reminders route and the sms:dry-run CLI; nothing on
// the live path imports this.
//
// DORMANT-SAFE: with the SMS_* / TWILIO_* env unset, a REAL run returns
// { status: "disabled" } immediately and does no DB work. A dry-run always
// runs (computing the would-be recipients) so the CLI can inspect them
// without ever sending or writing.
//
// Idempotency: we CLAIM a sms_reminder_log row per (coach, Pacific date)
// with onConflictDoNothing FIRST, and only text when the claim inserted.
// The unique index on (coach_id, for_date) means the two DST-spanning cron
// fires (see vercel.json) can never double-text a coach on the same day.

import { and, eq, gte, inArray, isNull, lt } from "drizzle-orm";

import { db } from "@/db";
import {
  hourLogs,
  programBlockCoachFlags,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  smsReminderLog,
  users,
} from "@/db/schema";
import { getSmsConfig } from "@/lib/sms/config";
import {
  renderReminderBody,
  SMS_LOG_URL,
  SmsSendError,
  sendSms,
} from "@/lib/sms/client";
import {
  normalizeUsPhoneE164,
  selectRecipients,
  type EligibleCoach,
  type ReminderCandidate,
  type ReminderLog,
  type Recipient,
} from "@/lib/sms/recipients";
import { formatPfaDate, pfaDayStart, pfaParts } from "@/lib/timezone";

/**
 * True when `now` falls within the 8 AM Pacific hour. The cron fires twice a
 * day (DST-spanning entries in vercel.json); the route uses this so exactly
 * one fire does work year-round. PURE.
 */
export function isPacific8am(now: Date): boolean {
  return pfaParts(now).hour === 8;
}

// How many Pacific mornings a still-unlogged shift keeps getting the 8 AM
// reminder. The job looks back this many days, so a shift gets reminded the
// morning after it (and each morning thereafter) until it's logged / handed
// off / marked no-cover, OR until it falls out of this trailing window — then
// the texts stop even if it's still unlogged (Mark's "a week then stop").
export const REMINDER_LOOKBACK_DAYS = 7;

export type ReminderWindow = {
  // Half-open UTC range covering the trailing REMINDER_LOOKBACK_DAYS Pacific
  // days (everything before today's Pacific midnight, back a week).
  startUtc: Date;
  endUtc: Date;
  // The Pacific ISO date the reminder is SENT on (today) — the per-morning
  // dedup key, so the two DST cron fires can't double-text, but the NEXT
  // morning is a new key and an unlogged shift gets re-reminded.
  forDate: string;
};

export type ReminderSummary =
  | { status: "disabled" }
  | { status: "dry-run"; window: ReminderWindow; recipients: Recipient[] }
  | {
      status: "ran";
      window: ReminderWindow;
      eligible: number;
      candidates: number;
      sent: number;
      failed: number;
      skipped: number;
    };

/**
 * The half-open UTC range covering the trailing REMINDER_LOOKBACK_DAYS Pacific
 * days (everything before today's Pacific midnight, back a week), plus TODAY's
 * Pacific ISO date string (the per-morning send/dedup key). PURE + deterministic.
 *
 * `endUtc` = today's Pacific midnight (so a shift scheduled today, not yet
 * overdue, is excluded). `startUtc` steps back one Pacific day at a time
 * (subtract 1ms → `pfaDayStart`) REMINDER_LOOKBACK_DAYS times so DST never
 * over/undershoots a day. A shift on day D is therefore in-window on the
 * mornings of D+1 … D+REMINDER_LOOKBACK_DAYS, then drops out.
 */
export function reminderWindow(now: Date): ReminderWindow {
  const todayStart = pfaDayStart(now);
  let startUtc = todayStart;
  for (let i = 0; i < REMINDER_LOOKBACK_DAYS; i++) {
    startUtc = pfaDayStart(new Date(startUtc.getTime() - 1));
  }
  return {
    startUtc,
    endUtc: todayStart,
    forDate: formatPfaDate(todayStart),
  };
}

/**
 * Runs the reminder job for the Pacific day before `now`.
 *
 * - Real run (`!dryRun`): no-ops to { status: "disabled" } unless the
 *   capability is enabled. Otherwise selects recipients, claims a per-coach
 *   reminder-log row (dedup), and texts the claimers.
 * - Dry run: always computes the recipients and returns them WITHOUT
 *   claiming, sending, or writing anything.
 */
export async function runSmsReminders(opts?: {
  dryRun?: boolean;
  now?: Date;
}): Promise<ReminderSummary> {
  const dryRun = opts?.dryRun ?? false;
  const now = opts?.now ?? new Date();
  const cfg = getSmsConfig();

  if (!dryRun && !cfg.enabled) {
    return { status: "disabled" };
  }

  const window = reminderWindow(now);

  // 1. Candidate (block, member-coach) pairs: program blocks whose start
  //    falls in the trailing-week Pacific window. A block stays a candidate
  //    every morning until it's logged (step 2) or flagged (below), or until
  //    it ages out of the window — giving the "remind for a week then stop".
  const candidateRows = await db
    .select({
      blockId: programScheduleBlocks.id,
      programId: programScheduleBlocks.programId,
      coachId: programScheduleBlockCoaches.coachId,
      startAt: programScheduleBlocks.startAt,
      endAt: programScheduleBlocks.endAt,
    })
    .from(programScheduleBlocks)
    .innerJoin(
      programScheduleBlockCoaches,
      eq(programScheduleBlockCoaches.blockId, programScheduleBlocks.id),
    )
    .where(
      and(
        gte(programScheduleBlocks.startAt, window.startUtc),
        lt(programScheduleBlocks.startAt, window.endUtc),
      ),
    );

  let candidates: ReminderCandidate[] = candidateRows.map((r) => ({
    blockId: r.blockId,
    coachId: r.coachId,
    programId: r.programId,
    startMs: r.startAt.getTime(),
    endMs: r.endAt.getTime(),
  }));

  // Stop reminding about a (block, coach) the coach has marked NO-COVER
  // (kind='cancelled') or that an admin has acknowledged as a NO-SHOW
  // (kind='no_show') — same suppression the needs-review queue uses. (A
  // handed-off shift drops out automatically: the giver is no longer a member,
  // so they're never in candidateRows.)
  if (candidates.length > 0) {
    const blockIds = [...new Set(candidates.map((c) => c.blockId))];
    const flagRows = await db
      .select({
        blockId: programBlockCoachFlags.blockId,
        coachId: programBlockCoachFlags.coachId,
      })
      .from(programBlockCoachFlags)
      .where(inArray(programBlockCoachFlags.blockId, blockIds));
    const flagged = new Set(flagRows.map((f) => `${f.blockId}:${f.coachId}`));
    candidates = candidates.filter(
      (c) => !flagged.has(`${c.blockId}:${c.coachId}`),
    );
  }

  if (candidates.length === 0) {
    return dryRun
      ? { status: "dry-run", window, recipients: [] }
      : {
          status: "ran",
          window,
          eligible: 0,
          candidates: 0,
          sent: 0,
          failed: 0,
          skipped: 0,
        };
  }

  const coachIds = [...new Set(candidates.map((c) => c.coachId))];

  // 2. POSTED logs for those coaches in the window (held logs excluded,
  //    mirroring needs-review — a held log is not yet a real log).
  const logRows = await db
    .select({
      coachId: hourLogs.coachId,
      programId: hourLogs.programId,
      startAt: hourLogs.startAt,
      endAt: hourLogs.endAt,
    })
    .from(hourLogs)
    .where(
      and(
        eq(hourLogs.status, "posted"),
        inArray(hourLogs.coachId, coachIds),
        gte(hourLogs.startAt, window.startUtc),
        lt(hourLogs.startAt, window.endUtc),
      ),
    );

  const logs: ReminderLog[] = logRows.map((r) => ({
    coachId: r.coachId,
    programId: r.programId,
    startMs: r.startAt.getTime(),
    endMs: r.endAt.getTime(),
  }));

  // 3. Eligible coaches: opted in, NOT opted out, active (not soft-deleted),
  //    with a phone that normalizes to E.164.
  const coachRows = await db
    .select({
      id: users.id,
      name: users.name,
      phone: users.phone,
    })
    .from(users)
    .where(
      and(
        inArray(users.id, coachIds),
        eq(users.smsOptIn, true),
        eq(users.smsOptOut, false),
        isNull(users.deletedAt),
      ),
    );

  const eligible: EligibleCoach[] = [];
  for (const c of coachRows) {
    const phone = normalizeUsPhoneE164(c.phone);
    if (!phone) continue;
    eligible.push({ coachId: c.id, name: c.name, phone });
  }

  const recipients = selectRecipients({ candidates, logs, eligible });

  if (dryRun) {
    return { status: "dry-run", window, recipients };
  }

  // 4. Real send. Claim → send → update status, per coach.
  const body = renderReminderBody(SMS_LOG_URL);

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of recipients) {
    // CLAIM the per-(coach, date) row first. onConflictDoNothing means a
    // concurrent / repeated run that already claimed this coach/day inserts
    // nothing → we skip the send (dedup / idempotency).
    const claimed = await db
      .insert(smsReminderLog)
      .values({
        coachId: r.coachId,
        forDate: window.forDate,
        status: "sent", // optimistic; corrected below on failure
      })
      .onConflictDoNothing({
        target: [smsReminderLog.coachId, smsReminderLog.forDate],
      })
      .returning({ id: smsReminderLog.id });

    if (claimed.length === 0) {
      // Already handled today — not counted as a new send.
      continue;
    }
    const rowId = claimed[0].id;

    try {
      const { sid } = await sendSms({
        accountSid: cfg.accountSid!,
        authToken: cfg.authToken!,
        from: cfg.fromNumber!,
        to: r.phone,
        body,
      });
      await db
        .update(smsReminderLog)
        .set({ status: "sent", twilioSid: sid })
        .where(eq(smsReminderLog.id, rowId));
      sent += 1;
    } catch (err) {
      if (err instanceof SmsSendError && err.isOptOut) {
        // Twilio says this coach is on the STOP list — mirror it so we never
        // try again, and record the skip.
        await db
          .update(users)
          .set({ smsOptOut: true })
          .where(eq(users.id, r.coachId));
        await db
          .update(smsReminderLog)
          .set({ status: "skipped_optout", error: err.message })
          .where(eq(smsReminderLog.id, rowId));
        skipped += 1;
      } else {
        const message =
          err instanceof Error ? err.message : "unknown send error";
        await db
          .update(smsReminderLog)
          .set({ status: "failed", error: message })
          .where(eq(smsReminderLog.id, rowId));
        failed += 1;
      }
    }
  }

  return {
    status: "ran",
    window,
    eligible: eligible.length,
    candidates: candidates.length,
    sent,
    failed,
    skipped,
  };
}
