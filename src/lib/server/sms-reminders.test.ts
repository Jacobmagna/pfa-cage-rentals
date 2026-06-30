// Tests for the PURE helpers in sms-reminders.ts: the Pacific-8AM cron gate
// and the trailing-week Pacific window derivation. The rest of the module hits
// the DB and is exercised by the integration suite.
//
// `sms-reminders.ts` imports `@/db`, which throws at module load if
// DATABASE_URL is unset — so we set a dummy one before importing. (The DB is
// never touched by these pure helpers.) Mirrors needs-review.test.ts.
import { beforeAll, describe, expect, it } from "vitest";

let isPacific8am: (now: Date) => boolean;
let reminderWindow: (now: Date) => {
  startUtc: Date;
  endUtc: Date;
  forDate: string;
};
let REMINDER_LOOKBACK_DAYS: number;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost.tld/testdb";
  ({ isPacific8am, reminderWindow, REMINDER_LOOKBACK_DAYS } = await import(
    "./sms-reminders"
  ));
});

describe("isPacific8am", () => {
  // PDT (summer) = UTC-7, so 8:00 AM Pacific = 15:00 UTC.
  it("is true at 8:00 AM Pacific in PDT (15:00 UTC)", () => {
    expect(isPacific8am(new Date("2026-06-09T15:00:00.000Z"))).toBe(true);
  });

  it("is true anywhere in the 8 AM Pacific hour (08:59 PDT = 15:59 UTC)", () => {
    expect(isPacific8am(new Date("2026-06-09T15:59:00.000Z"))).toBe(true);
  });

  it("is false at 7:59 AM Pacific (14:59 UTC, PDT)", () => {
    expect(isPacific8am(new Date("2026-06-09T14:59:00.000Z"))).toBe(false);
  });

  it("is false at 9:00 AM Pacific (16:00 UTC, PDT)", () => {
    expect(isPacific8am(new Date("2026-06-09T16:00:00.000Z"))).toBe(false);
  });

  // PST (winter) = UTC-8, so 8:00 AM Pacific = 16:00 UTC. The two
  // vercel.json schedules (15:05 + 16:05 UTC) straddle exactly this DST flip.
  it("is true at 8:00 AM Pacific in PST (16:00 UTC)", () => {
    expect(isPacific8am(new Date("2026-01-09T16:00:00.000Z"))).toBe(true);
  });

  it("is false at 8:00 AM Pacific-PDT-clock during PST (15:00 UTC = 7 AM PST)", () => {
    expect(isPacific8am(new Date("2026-01-09T15:00:00.000Z"))).toBe(false);
  });
});

describe("reminderWindow", () => {
  it("forDate is TODAY's Pacific date (the send day, not the shift day) (PDT)", () => {
    // Now = 8 AM Pacific on 2026-06-09 (15:00 UTC).
    const w = reminderWindow(new Date("2026-06-09T15:00:00.000Z"));
    expect(w.forDate).toBe("2026-06-09");
  });

  it("spans the trailing REMINDER_LOOKBACK_DAYS, ending at today's Pacific midnight (PDT)", () => {
    const w = reminderWindow(new Date("2026-06-09T15:00:00.000Z"));
    // endUtc = today's PDT midnight (Jun 9 00:00 PDT = 07:00 UTC).
    expect(w.endUtc.toISOString()).toBe("2026-06-09T07:00:00.000Z");
    // startUtc = 7 Pacific days earlier (Jun 2 00:00 PDT = 07:00 UTC).
    expect(w.startUtc.toISOString()).toBe("2026-06-02T07:00:00.000Z");
    // Exactly REMINDER_LOOKBACK_DAYS apart (no DST flip in this span).
    const days = (w.endUtc.getTime() - w.startUtc.getTime()) / 86_400_000;
    expect(days).toBe(REMINDER_LOOKBACK_DAYS);
  });

  it("uses today's date even just after midnight Pacific", () => {
    // 00:30 Pacific on Jun 9 (PDT) = 07:30 UTC → send day is Jun 9.
    const w = reminderWindow(new Date("2026-06-09T07:30:00.000Z"));
    expect(w.forDate).toBe("2026-06-09");
  });

  it("works in PST (winter, UTC-8)", () => {
    // 8 AM Pacific on 2026-01-09 (PST) = 16:00 UTC.
    const w = reminderWindow(new Date("2026-01-09T16:00:00.000Z"));
    expect(w.forDate).toBe("2026-01-09");
    // PST midnight of Jan 9 = 08:00 UTC; 7 days earlier (Jan 2) = 08:00 UTC.
    expect(w.endUtc.toISOString()).toBe("2026-01-09T08:00:00.000Z");
    expect(w.startUtc.toISOString()).toBe("2026-01-02T08:00:00.000Z");
  });

  it("steps day-by-day so a DST spring-forward in the span stays exactly 7 days", () => {
    // DST spring-forward is 2026-03-08. Now = 8 AM Pacific 2026-03-10 (PDT,
    // 15:00 UTC). The 7-day window crosses the flip (Mar 3 PST → Mar 10 PDT).
    const w = reminderWindow(new Date("2026-03-10T15:00:00.000Z"));
    expect(w.forDate).toBe("2026-03-10");
    // endUtc = Mar 10 00:00 PDT = 07:00 UTC; startUtc = Mar 3 00:00 PST = 08:00 UTC.
    expect(w.endUtc.toISOString()).toBe("2026-03-10T07:00:00.000Z");
    expect(w.startUtc.toISOString()).toBe("2026-03-03T08:00:00.000Z");
  });
});
