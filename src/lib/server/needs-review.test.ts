// Tests for the pure no-show timing helper in needs-review.ts.
//
// `noShowDueAt` is the only piece of needs-review.ts that's pure (the rest
// hits the DB). It decides WHEN a scheduled block that a coach didn't log
// first counts as a no-show: 8:00 AM Pacific on the calendar day AFTER the
// block ended. We assert against fixed UTC instants (accounting for the
// Pacific offset) so the test is deterministic regardless of the runtime TZ.
//
// `needs-review.ts` imports `@/db`, which throws at module load if
// DATABASE_URL is unset — so we stub it before importing. (The DB is never
// touched by `noShowDueAt` itself; the type-only card import is erased.)
import { beforeAll, describe, expect, it } from "vitest";

let noShowDueAt: (blockEndAt: Date) => Date;

beforeAll(async () => {
  process.env.DATABASE_URL ??=
    "postgresql://user:pass@localhost.tld/testdb";
  ({ noShowDueAt } = await import("./needs-review"));
});

describe("noShowDueAt", () => {
  // A block ending Mon May 4 2026 3:00 PM Pacific (PDT = UTC-7) = 22:00 UTC.
  // The no-show threshold is 8:00 AM Pacific on Tue May 5 = 15:00 UTC.
  const mon3pmPdt = new Date("2026-05-04T22:00:00.000Z");

  it("returns 8 AM Pacific the day after the block ended (PDT)", () => {
    expect(noShowDueAt(mon3pmPdt).toISOString()).toBe(
      "2026-05-05T15:00:00.000Z",
    );
  });

  it("returns 8 AM Pacific the day after (PST, January = UTC-8)", () => {
    // Block ends Wed Jan 14 2026 3:00 PM PST (UTC-8) = 23:00 UTC.
    // Threshold = 8:00 AM PST on Thu Jan 15 = 16:00 UTC.
    const wed3pmPst = new Date("2026-01-14T23:00:00.000Z");
    expect(noShowDueAt(wed3pmPst).toISOString()).toBe(
      "2026-01-15T16:00:00.000Z",
    );
  });

  it("uses the block's PACIFIC calendar day, not the UTC day", () => {
    // Block ends Mon May 4 2026 11:30 PM Pacific = 06:30 UTC on May 5.
    // The UTC day is already Tue, but the Pacific day is still Mon, so the
    // threshold must be 8 AM Pacific on Tue May 5 (= 15:00 UTC), NOT Wed.
    const monLatePdt = new Date("2026-05-05T06:30:00.000Z");
    expect(noShowDueAt(monLatePdt).toISOString()).toBe(
      "2026-05-05T15:00:00.000Z",
    );
  });
});

describe("no-show due-yet logic (now >= noShowDueAt)", () => {
  // A block ending Mon May 4 2026 3:00 PM Pacific.
  const blockEnd = new Date("2026-05-04T22:00:00.000Z");
  const isDue = (now: Date) => now.getTime() >= noShowDueAt(blockEnd).getTime();

  it("is NOT a no-show later the same evening (Mon 11 PM Pacific)", () => {
    // Mon May 4 11:00 PM PDT = 06:00 UTC Tue.
    expect(isDue(new Date("2026-05-05T06:00:00.000Z"))).toBe(false);
  });

  it("is NOT a no-show at 7:59 AM Pacific the next day", () => {
    // Tue May 5 7:59 AM PDT = 14:59 UTC.
    expect(isDue(new Date("2026-05-05T14:59:00.000Z"))).toBe(false);
  });

  it("IS a no-show at exactly 8:00 AM Pacific the next day", () => {
    // Tue May 5 8:00 AM PDT = 15:00 UTC.
    expect(isDue(new Date("2026-05-05T15:00:00.000Z"))).toBe(true);
  });

  it("IS a no-show well after 8:00 AM the next day", () => {
    expect(isDue(new Date("2026-05-05T20:00:00.000Z"))).toBe(true);
  });
});
