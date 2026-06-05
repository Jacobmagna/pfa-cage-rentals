// Unit tests for the pure schedule-reconciliation engine (FEAT-16).
// Pure module → no DB, no mocks: fixed Dates + a deterministic stub
// formatTime that prints UTC "HH:MM" so the asserted detail strings are
// stable regardless of the runner's TZ. Mirrors attendance-flags.test.ts.
//
// Proves the settled rules: logged (exact + within-tol both ends),
// wrong_time (S overlaps off-tol), wrong_coach (only another coach
// overlaps), no_show (no logs, now past end+buffer), pending (no logs,
// now before end+buffer), precedence (S off-time beats another coach's
// on-time log → wrong_time), and the ±15-min tolerance boundary
// (exactly 15 → logged; 16 → not). For annotateLogs: unscheduled → null,
// on-schedule → null, wrong-coach → "{name} was scheduled.", wrong-time
// same-coach → "Scheduled …".

import { describe, expect, it } from "vitest";
import {
  annotateLogs,
  reconcileBlocks,
  type ReconBlock,
  type ReconLog,
} from "./reconciliation";

// UTC "HH:MM" stub — deterministic, TZ-independent.
const fmt = (d: Date) => d.toISOString().slice(11, 16);

const MIN = 60_000;
const at = (iso: string) => new Date(iso);

// A scheduled block: program p1, coach c1 ("Sam"), 14:00–15:00 UTC.
// `coaches` defaults to the single primary so single-coach behavior is
// byte-identical to pre-W3.2; multi-coach tests pass `coaches` explicitly.
function block(over: Partial<ReconBlock> = {}): ReconBlock {
  const base = {
    id: "b1",
    programId: "p1",
    scheduledCoachId: "c1",
    scheduledCoachName: "Sam",
    startAt: at("2026-06-01T14:00:00Z"),
    endAt: at("2026-06-01T15:00:00Z"),
    ...over,
  };
  return {
    ...base,
    coaches: over.coaches ?? [
      { coachId: base.scheduledCoachId, coachName: base.scheduledCoachName },
    ],
  };
}

function log(over: Partial<ReconLog> = {}): ReconLog {
  return {
    coachId: "c1",
    coachName: "Sam",
    programId: "p1",
    startAt: at("2026-06-01T14:00:00Z"),
    endAt: at("2026-06-01T15:00:00Z"),
    ...over,
  };
}

const NOW_DONE = at("2026-06-01T20:00:00Z"); // well past end + buffer

describe("reconcileBlocks", () => {
  it("logged — scheduled coach logs the exact window", () => {
    const r = reconcileBlocks(
      { blocks: [block()], logs: [log()], now: NOW_DONE },
      fmt,
    );
    expect(r.b1.status).toBe("logged");
    expect(r.b1.detail).toBe("On schedule — Sam logged 14:00–15:00.");
  });

  it("logged — within tolerance on BOTH ends (±15 min)", () => {
    const r = reconcileBlocks(
      {
        blocks: [block()],
        logs: [
          log({
            startAt: at("2026-06-01T14:10:00Z"),
            endAt: at("2026-06-01T15:12:00Z"),
          }),
        ],
        now: NOW_DONE,
      },
      fmt,
    );
    expect(r.b1.status).toBe("logged");
  });

  it("wrong_time — scheduled coach overlaps but off-tolerance", () => {
    const r = reconcileBlocks(
      {
        blocks: [block()],
        logs: [
          log({
            startAt: at("2026-06-01T14:30:00Z"),
            endAt: at("2026-06-01T15:30:00Z"),
          }),
        ],
        now: NOW_DONE,
      },
      fmt,
    );
    expect(r.b1.status).toBe("wrong_time");
    expect(r.b1.detail).toBe(
      "Sam logged 14:30–15:30 instead of the scheduled 14:00–15:00.",
    );
  });

  it("wrong_coach — only another coach overlaps", () => {
    const r = reconcileBlocks(
      {
        blocks: [block()],
        logs: [log({ coachId: "c2", coachName: "Lee" })],
        now: NOW_DONE,
      },
      fmt,
    );
    expect(r.b1.status).toBe("wrong_coach");
    expect(r.b1.detail).toBe("Lee logged 14:00–15:00 instead of Sam.");
  });

  it("no_show — no logs and now past end + 1hr buffer", () => {
    const r = reconcileBlocks(
      { blocks: [block()], logs: [], now: NOW_DONE },
      fmt,
    );
    expect(r.b1.status).toBe("no_show");
    expect(r.b1.detail).toBe("Sam didn't log anything for this block.");
  });

  it("pending — no logs and now before end + buffer", () => {
    const r = reconcileBlocks(
      // end is 15:00; buffer is 1hr → boundary at 16:00. 15:30 is before.
      { blocks: [block()], logs: [], now: at("2026-06-01T15:30:00Z") },
      fmt,
    );
    expect(r.b1.status).toBe("pending");
    expect(r.b1.detail).toBe("Scheduled window hasn't closed yet.");
  });

  it("no_show — exactly at end + buffer boundary flips to no_show", () => {
    const r = reconcileBlocks(
      { blocks: [block()], logs: [], now: at("2026-06-01T16:00:00Z") },
      fmt,
    );
    expect(r.b1.status).toBe("no_show");
  });

  it("precedence — S off-time + other coach on-time → wrong_time (S wins)", () => {
    const r = reconcileBlocks(
      {
        blocks: [block()],
        logs: [
          // Sam logged off-tolerance.
          log({
            startAt: at("2026-06-01T14:30:00Z"),
            endAt: at("2026-06-01T15:30:00Z"),
          }),
          // Another coach logged exactly on schedule.
          log({ coachId: "c2", coachName: "Lee" }),
        ],
        now: NOW_DONE,
      },
      fmt,
    );
    expect(r.b1.status).toBe("wrong_time");
  });

  it("tolerance boundary — exactly 15 min off → logged", () => {
    const r = reconcileBlocks(
      {
        blocks: [block()],
        logs: [
          log({
            startAt: new Date(at("2026-06-01T14:00:00Z").getTime() + 15 * MIN),
            endAt: new Date(at("2026-06-01T15:00:00Z").getTime() + 15 * MIN),
          }),
        ],
        now: NOW_DONE,
      },
      fmt,
    );
    expect(r.b1.status).toBe("logged");
  });

  it("tolerance boundary — 16 min off → not logged (wrong_time)", () => {
    const r = reconcileBlocks(
      {
        blocks: [block()],
        logs: [
          log({
            startAt: new Date(at("2026-06-01T14:00:00Z").getTime() + 16 * MIN),
            endAt: new Date(at("2026-06-01T15:00:00Z").getTime() + 16 * MIN),
          }),
        ],
        now: NOW_DONE,
      },
      fmt,
    );
    expect(r.b1.status).toBe("wrong_time");
  });

  it("ignores logs for a different program", () => {
    const r = reconcileBlocks(
      {
        blocks: [block()],
        logs: [log({ programId: "p2" })],
        now: NOW_DONE,
      },
      fmt,
    );
    expect(r.b1.status).toBe("no_show");
  });

  it("single-coach result carries a coaches[] of length 1 mirroring the block", () => {
    const r = reconcileBlocks(
      { blocks: [block()], logs: [log()], now: NOW_DONE },
      fmt,
    );
    expect(r.b1.coaches).toHaveLength(1);
    expect(r.b1.coaches[0]).toMatchObject({
      coachId: "c1",
      coachName: "Sam",
      status: "logged",
    });
    // Aggregate detail is byte-identical to the single coach's detail.
    expect(r.b1.detail).toBe(r.b1.coaches[0].detail);
  });

  describe("multi-coach (QA10 W3.2)", () => {
    // Two scheduled coaches: c1 "Ana" (primary) + c2 "Ben".
    const twoCoaches = () =>
      block({
        scheduledCoachId: "c1",
        scheduledCoachName: "Ana",
        coaches: [
          { coachId: "c1", coachName: "Ana" },
          { coachId: "c2", coachName: "Ben" },
        ],
      });

    it("one coach on-time, the other no-shows → per-coach split, aggregate red", () => {
      const r = reconcileBlocks(
        {
          blocks: [twoCoaches()],
          // Only Ana logs on schedule; Ben logs nothing.
          logs: [log({ coachId: "c1", coachName: "Ana" })],
          now: NOW_DONE,
        },
        fmt,
      );
      expect(r.b1.coaches.map((c) => c.status)).toEqual(["logged", "no_show"]);
      // no_show outranks logged → aggregate red (no_show).
      expect(r.b1.status).toBe("no_show");
      // Pinned aggregate detail format: "<name>: <detail>" joined by "  ·  ".
      expect(r.b1.detail).toBe(
        "Ana: On schedule — Ana logged 14:00–15:00.  ·  Ben: Ben didn't log anything for this block.",
      );
    });

    it("an UNSCHEDULED coach's log → wrong_coach for both scheduled coaches", () => {
      const r = reconcileBlocks(
        {
          blocks: [twoCoaches()],
          // c3 "Cy" is NOT in the block's coach set.
          logs: [log({ coachId: "c3", coachName: "Cy" })],
          now: NOW_DONE,
        },
        fmt,
      );
      expect(r.b1.coaches.map((c) => c.status)).toEqual([
        "wrong_coach",
        "wrong_coach",
      ]);
      expect(r.b1.coaches[0].detail).toBe(
        "Cy logged 14:00–15:00 instead of Ana.",
      );
      expect(r.b1.status).toBe("wrong_coach");
    });

    it("a SCHEDULED coach's on-time log does NOT count as wrong_coach against the other coach", () => {
      const r = reconcileBlocks(
        {
          blocks: [twoCoaches()],
          // Ben (scheduled) logs on time; Ana logs nothing.
          logs: [log({ coachId: "c2", coachName: "Ben" })],
          now: NOW_DONE,
        },
        fmt,
      );
      // Ana sees no_show (Ben is in the set, so not "wrong_coach"); Ben logged.
      expect(r.b1.coaches.map((c) => c.status)).toEqual(["no_show", "logged"]);
      expect(r.b1.status).toBe("no_show");
    });

    it("both coaches log on time → aggregate green (all logged)", () => {
      const r = reconcileBlocks(
        {
          blocks: [twoCoaches()],
          logs: [
            log({ coachId: "c1", coachName: "Ana" }),
            log({ coachId: "c2", coachName: "Ben" }),
          ],
          now: NOW_DONE,
        },
        fmt,
      );
      expect(r.b1.coaches.map((c) => c.status)).toEqual(["logged", "logged"]);
      expect(r.b1.status).toBe("logged");
    });
  });
});

describe("annotateLogs", () => {
  it("unscheduled log (no overlapping block) → null", () => {
    const r = annotateLogs(
      { logs: [{ ...log(), id: "l1" }], blocks: [] },
      fmt,
    );
    expect(r.l1).toBeNull();
  });

  it("on-schedule log → null", () => {
    const r = annotateLogs(
      { logs: [{ ...log(), id: "l1" }], blocks: [block()] },
      fmt,
    );
    expect(r.l1).toBeNull();
  });

  it("wrong-coach log → '{scheduled name} was scheduled.'", () => {
    const r = annotateLogs(
      {
        logs: [{ ...log({ coachId: "c2", coachName: "Lee" }), id: "l1" }],
        blocks: [block()],
      },
      fmt,
    );
    expect(r.l1).toBe("Sam was scheduled.");
  });

  it("wrong-time same-coach log → 'Scheduled …'", () => {
    const r = annotateLogs(
      {
        logs: [
          {
            ...log({
              startAt: at("2026-06-01T14:30:00Z"),
              endAt: at("2026-06-01T15:30:00Z"),
            }),
            id: "l1",
          },
        ],
        blocks: [block()],
      },
      fmt,
    );
    expect(r.l1).toBe("Scheduled 14:00–15:00.");
  });

  it("prefers the same-coach in-tolerance block when several overlap", () => {
    // Two overlapping blocks: one scheduled for another coach, one for
    // this coach on-time → on-schedule wins → null.
    const r = annotateLogs(
      {
        logs: [{ ...log(), id: "l1" }],
        blocks: [
          block({ id: "bx", scheduledCoachId: "c2", scheduledCoachName: "Lee" }),
          block({ id: "by" }),
        ],
      },
      fmt,
    );
    expect(r.l1).toBeNull();
  });

  it("multi-coach: a log by a coach IN the 2-coach set, on-time → null", () => {
    // Block scheduled for Ana + Ben; Ben (in the set) logs on time.
    const r = annotateLogs(
      {
        logs: [{ ...log({ coachId: "c2", coachName: "Ben" }), id: "l1" }],
        blocks: [
          block({
            scheduledCoachId: "c1",
            scheduledCoachName: "Ana",
            coaches: [
              { coachId: "c1", coachName: "Ana" },
              { coachId: "c2", coachName: "Ben" },
            ],
          }),
        ],
      },
      fmt,
    );
    expect(r.l1).toBeNull();
  });

  it("multi-coach: a log by an OUTSIDER → 'A, B were scheduled.'", () => {
    // Block scheduled for Ana + Ben; Cy (outsider) logs.
    const r = annotateLogs(
      {
        logs: [{ ...log({ coachId: "c3", coachName: "Cy" }), id: "l1" }],
        blocks: [
          block({
            scheduledCoachId: "c1",
            scheduledCoachName: "Ana",
            coaches: [
              { coachId: "c1", coachName: "Ana" },
              { coachId: "c2", coachName: "Ben" },
            ],
          }),
        ],
      },
      fmt,
    );
    expect(r.l1).toBe("Ana, Ben were scheduled.");
  });
});
