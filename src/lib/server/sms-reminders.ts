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
  programScheduleBlockCoaches,
  programScheduleBlocks,
  smsReminderLog,
  users,
} from "@/db/schema";
import { getSmsConfig } from "@/lib/sms/config";
import { renderReminderBody, SmsSendError, sendSms } from "@/lib/sms/client";
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

export type ReminderWindow = {
  // Half-open UTC range for "yesterday" in the Pacific calendar.
  startUtc: Date;
  endUtc: Date;
  // The Pacific ISO date the reminder is ABOUT (the dedup key), e.g.
  // "2026-06-09".
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
 * The half-open UTC range for the PACIFIC calendar day BEFORE `now`, plus
 * that day's Pacific ISO date string (the dedup key). PURE + deterministic.
 *
 * `pfaDayStart(now)` is today's Pacific midnight (in UTC); stepping back 1ms
 * lands on the last instant of YESTERDAY (Pacific) regardless of DST, and
 * `pfaDayStart` of that snaps to yesterday's Pacific midnight. `endUtc` is
 * today's Pacific midnight. (A fixed −25h step would overshoot into the
 * day-before-yesterday on a 24h Pacific day.)
 */
export function yesterdayPacificWindow(now: Date): ReminderWindow {
  const todayStart = pfaDayStart(now);
  const yesterdayStart = pfaDayStart(new Date(todayStart.getTime() - 1));
  return {
    startUtc: yesterdayStart,
    endUtc: todayStart,
    forDate: formatPfaDate(yesterdayStart),
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

  const window = yesterdayPacificWindow(now);

  // 1. Candidate (block, member-coach) pairs: program blocks that fall in
  //    yesterday's Pacific window. (We key on startAt within the day — a
  //    block scheduled yesterday is a reminder candidate.)
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

  const candidates: ReminderCandidate[] = candidateRows.map((r) => ({
    blockId: r.blockId,
    coachId: r.coachId,
    programId: r.programId,
    startMs: r.startAt.getTime(),
    endMs: r.endAt.getTime(),
  }));

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
  const link = `${process.env.AUTH_URL ?? ""}/coach/hour-log`;
  const body = renderReminderBody(link);

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
