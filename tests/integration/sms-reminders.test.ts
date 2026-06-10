// Integration tests for the 1b #25 SMS reminder server layer. Hits a real
// Neon dev branch (see vitest.integration.config.ts + tests/integration/
// setup.ts). The capability stays DORMANT here — no Twilio env is set — so a
// REAL run returns { status: "disabled" } and we exercise the recipient
// SELECTION via the dry-run path (which never sends or writes) plus the
// sms_reminder_log idempotency directly.
//
// These tables aren't truncated by truncateMutables(), so we create our own
// rows with unique keys in a fixed PAST window and clean them up in afterAll.
// We pin a fixed "now" so the yesterday-Pacific window is deterministic.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  hourLogs,
  programScheduleBlockCoaches,
  programScheduleBlocks,
  programs,
  smsReminderLog,
  users,
} from "@/db/schema";
import { runSmsReminders } from "@/lib/server/sms-reminders";
import { getSmsConfig } from "@/lib/sms/config";

// @/db pulls @/auth → next-auth, which doesn't resolve in vitest's node env.
// We never exercise real auth here (mirrors the other integration suites).
vi.mock("@/auth", () => ({ auth: vi.fn() }));

// Fixed "now": 8 AM Pacific (PDT) on 2026-03-10 = 15:00 UTC. So the
// yesterday-Pacific window is 2026-03-09 (PDT midnight = 08:00 UTC both ends
// after the DST spring-forward on 2026-03-08... we keep it well clear: pick a
// date where the prior day is unambiguous).
const NOW = new Date("2026-03-10T15:00:00.000Z");
// Yesterday Pacific = 2026-03-09. A block at 10 AM PDT that day = 17:00 UTC.
const blockStart = new Date("2026-03-09T17:00:00.000Z");
const blockEnd = new Date("2026-03-09T18:00:00.000Z");

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let optedInCoachId: string; // opted in, valid phone, did NOT log → recipient
let loggedCoachId: string; // opted in, valid phone, DID log → not a recipient
let optedOutCoachId: string; // opted in toggle but smsOptOut=true → excluded
let noPhoneCoachId: string; // opted in, no phone → excluded
let adminId: string;
let programId: string;
const createdUserIds: string[] = [];
const createdBlockIds: string[] = [];

beforeAll(async () => {
  const suffix = uniqueSuffix();

  const [admin] = await db
    .insert(users)
    .values({ email: `sms-admin-${suffix}@pfa.invalid`, name: "SMS Admin", role: "admin" })
    .returning({ id: users.id });
  adminId = admin.id;

  const [optedIn] = await db
    .insert(users)
    .values({
      email: `sms-in-${suffix}@pfa.invalid`,
      name: "SMS OptedIn",
      role: "coach",
      phone: "4155550101",
      smsOptIn: true,
      smsOptOut: false,
    })
    .returning({ id: users.id });
  optedInCoachId = optedIn.id;

  const [logged] = await db
    .insert(users)
    .values({
      email: `sms-logged-${suffix}@pfa.invalid`,
      name: "SMS Logged",
      role: "coach",
      phone: "4155550102",
      smsOptIn: true,
      smsOptOut: false,
    })
    .returning({ id: users.id });
  loggedCoachId = logged.id;

  const [optedOut] = await db
    .insert(users)
    .values({
      email: `sms-out-${suffix}@pfa.invalid`,
      name: "SMS OptedOut",
      role: "coach",
      phone: "4155550103",
      smsOptIn: true,
      smsOptOut: true, // carrier STOP — excluded
    })
    .returning({ id: users.id });
  optedOutCoachId = optedOut.id;

  const [noPhone] = await db
    .insert(users)
    .values({
      email: `sms-nophone-${suffix}@pfa.invalid`,
      name: "SMS NoPhone",
      role: "coach",
      phone: null,
      smsOptIn: true,
      smsOptOut: false,
    })
    .returning({ id: users.id });
  noPhoneCoachId = noPhone.id;

  createdUserIds.push(
    adminId,
    optedInCoachId,
    loggedCoachId,
    optedOutCoachId,
    noPhoneCoachId,
  );

  const [program] = await db
    .insert(programs)
    .values({ name: `SMS Program ${suffix}`, active: true })
    .returning({ id: programs.id });
  programId = program.id;

  // One block per coach, all scheduled yesterday-Pacific, each coach a member.
  const mk = async (coachId: string) => {
    const [b] = await db
      .insert(programScheduleBlocks)
      .values({
        programId,
        scheduledCoachId: coachId,
        startAt: blockStart,
        endAt: blockEnd,
        createdBy: adminId,
      })
      .returning({ id: programScheduleBlocks.id });
    await db
      .insert(programScheduleBlockCoaches)
      .values({ blockId: b.id, coachId });
    createdBlockIds.push(b.id);
  };
  await mk(optedInCoachId);
  await mk(loggedCoachId);
  await mk(optedOutCoachId);
  await mk(noPhoneCoachId);

  // loggedCoach DID log a matching posted hour → not a recipient.
  await db.insert(hourLogs).values({
    coachId: loggedCoachId,
    programId,
    startAt: blockStart,
    endAt: blockEnd,
    status: "posted",
    createdBy: loggedCoachId,
  });
});

afterAll(async () => {
  await db.delete(smsReminderLog).where(inArray(smsReminderLog.coachId, createdUserIds));
  await db.delete(hourLogs).where(eq(hourLogs.programId, programId));
  if (createdBlockIds.length > 0) {
    await db
      .delete(programScheduleBlockCoaches)
      .where(inArray(programScheduleBlockCoaches.blockId, createdBlockIds));
    await db
      .delete(programScheduleBlocks)
      .where(inArray(programScheduleBlocks.id, createdBlockIds));
  }
  await db.delete(programs).where(eq(programs.id, programId));
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("SMS config is dormant without Twilio env", () => {
  it("getSmsConfig().enabled is false with no env set", () => {
    expect(getSmsConfig().enabled).toBe(false);
  });

  it("a real runSmsReminders no-ops to { status: 'disabled' }", async () => {
    const summary = await runSmsReminders({ dryRun: false, now: NOW });
    expect(summary.status).toBe("disabled");
  });
});

describe("recipient selection (dry-run, against seeded data)", () => {
  it("selects only opted-in, not-opted-out, valid-phone coaches who didn't log", async () => {
    const summary = await runSmsReminders({ dryRun: true, now: NOW });
    expect(summary.status).toBe("dry-run");
    if (summary.status !== "dry-run") return;

    const ids = summary.recipients.map((r) => r.coachId);
    // Only the opted-in coach who did NOT log is a recipient.
    expect(ids).toContain(optedInCoachId);
    // Logged coach excluded (their block was logged).
    expect(ids).not.toContain(loggedCoachId);
    // Opted-out coach excluded (carrier STOP).
    expect(ids).not.toContain(optedOutCoachId);
    // No-phone coach excluded.
    expect(ids).not.toContain(noPhoneCoachId);

    // The recipient's phone is normalized to E.164.
    const me = summary.recipients.find((r) => r.coachId === optedInCoachId);
    expect(me?.phone).toBe("+14155550101");

    // window is the prior Pacific day.
    expect(summary.window.forDate).toBe("2026-03-09");
  });

  it("dry-run writes NOTHING to sms_reminder_log", async () => {
    await runSmsReminders({ dryRun: true, now: NOW });
    const rows = await db
      .select()
      .from(smsReminderLog)
      .where(inArray(smsReminderLog.coachId, createdUserIds));
    expect(rows).toHaveLength(0);
  });
});

describe("sms_reminder_log idempotency", () => {
  it("the (coach_id, for_date) unique index dedupes a double claim", async () => {
    const forDate = "2026-03-09";

    const first = await db
      .insert(smsReminderLog)
      .values({ coachId: optedInCoachId, forDate, status: "sent" })
      .onConflictDoNothing({
        target: [smsReminderLog.coachId, smsReminderLog.forDate],
      })
      .returning({ id: smsReminderLog.id });
    expect(first).toHaveLength(1);

    // Second claim for the same (coach, date) inserts NOTHING.
    const second = await db
      .insert(smsReminderLog)
      .values({ coachId: optedInCoachId, forDate, status: "sent" })
      .onConflictDoNothing({
        target: [smsReminderLog.coachId, smsReminderLog.forDate],
      })
      .returning({ id: smsReminderLog.id });
    expect(second).toHaveLength(0);

    // Exactly one row exists for this coach/date.
    const rows = await db
      .select()
      .from(smsReminderLog)
      .where(
        and(
          eq(smsReminderLog.coachId, optedInCoachId),
          eq(smsReminderLog.forDate, forDate),
        ),
      );
    expect(rows).toHaveLength(1);
  });
});
