// Tests for the PURE helpers in sms-reminders.ts: the Pacific-8AM cron gate
// and the "yesterday Pacific" window derivation. The rest of the module hits
// the DB and is exercised by the integration suite.
//
// `sms-reminders.ts` imports `@/db`, which throws at module load if
// DATABASE_URL is unset — so we set a dummy one before importing. (The DB is
// never touched by these pure helpers.) Mirrors needs-review.test.ts.
import { beforeAll, describe, expect, it } from "vitest";

let isPacific8am: (now: Date) => boolean;
let yesterdayPacificWindow: (now: Date) => {
  startUtc: Date;
  endUtc: Date;
  forDate: string;
};

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgresql://user:pass@localhost.tld/testdb";
  ({ isPacific8am, yesterdayPacificWindow } = await import("./sms-reminders"));
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

describe("yesterdayPacificWindow", () => {
  it("returns the prior Pacific calendar day as a half-open UTC window (PDT)", () => {
    // Now = 8 AM Pacific on 2026-06-09 (15:00 UTC). Yesterday = 2026-06-08.
    const w = yesterdayPacificWindow(new Date("2026-06-09T15:00:00.000Z"));
    expect(w.forDate).toBe("2026-06-08");
    // PDT midnight (00:00) of Jun 8 = 07:00 UTC; of Jun 9 = 07:00 UTC.
    expect(w.startUtc.toISOString()).toBe("2026-06-08T07:00:00.000Z");
    expect(w.endUtc.toISOString()).toBe("2026-06-09T07:00:00.000Z");
  });

  it("computes the correct prior day even just after midnight Pacific", () => {
    // 00:30 Pacific on Jun 9 (PDT) = 07:30 UTC → yesterday is still Jun 8.
    const w = yesterdayPacificWindow(new Date("2026-06-09T07:30:00.000Z"));
    expect(w.forDate).toBe("2026-06-08");
  });

  it("works in PST (winter, UTC-8)", () => {
    // 8 AM Pacific on 2026-01-09 (PST) = 16:00 UTC. Yesterday = 2026-01-08.
    const w = yesterdayPacificWindow(new Date("2026-01-09T16:00:00.000Z"));
    expect(w.forDate).toBe("2026-01-08");
    // PST midnight of Jan 8 = 08:00 UTC; of Jan 9 = 08:00 UTC.
    expect(w.startUtc.toISOString()).toBe("2026-01-08T08:00:00.000Z");
    expect(w.endUtc.toISOString()).toBe("2026-01-09T08:00:00.000Z");
  });

  it("the window is exactly the day before today's Pacific midnight", () => {
    const now = new Date("2026-06-09T15:00:00.000Z");
    const w = yesterdayPacificWindow(now);
    // endUtc is today's Pacific midnight; startUtc is yesterday's.
    expect(w.endUtc.getTime()).toBeGreaterThan(w.startUtc.getTime());
  });
});
