// Unit tests for the two PURE pay-snapshot resolvers, across the full
// (override x program) branch space. These decide what money is stamped on
// every hour_logs row, so the matrix is exhaustive rather than illustrative.
//
// Migration 0052 added PROGRAM-level per-session pay. The bug it fixes, in
// one line: "HS Summer Travel - Game" pays a flat $100 PER GAME, but the only
// per-session setting lived on the per-(coach, program) override — so the
// program had to be faked with an hourly rate, and a 3.5-hour game paid $350.
//
// Two invariants these tests exist to protect:
//   1. BACKWARD COMPATIBILITY — every program that existed before 0052
//      backfills to payMode "hourly", and for those the resolvers must behave
//      EXACTLY as they did before. A regression here silently re-rates a live
//      payroll.
//   2. PRECEDENCE — a (coach, program) override always beats the program
//      default, including an HOURLY override on a PER-SESSION program.

import { describe, expect, it, vi } from "vitest";

// The resolvers under test are PURE, but they live in a module that opens a
// DB client at import time (@/db throws without DATABASE_URL). Mock that one
// boundary so this stays a real unit test — same convention as
// src/app/actions.test.ts. vi.mock is hoisted above the imports below.
vi.mock("@/db", () => ({ db: {} }));

import {
  resolvePerSessionRateCents,
  resolveRateCentsForProgram,
  type ProgramPayConfig,
} from "./hour-log-actions";
import { workPayForLog } from "@/lib/billing";

type Override = Parameters<typeof resolveRateCentsForProgram>[0];

function override(o: {
  payMode: "hourly" | "per_session";
  ratePer30MinCents?: number | null;
  perSessionRateCents?: number | null;
}): Override {
  return {
    coachId: "coach-1",
    programId: "program-1",
    payMode: o.payMode,
    ratePer30MinCents: o.ratePer30MinCents ?? null,
    perSessionRateCents: o.perSessionRateCents ?? null,
    updatedAt: new Date("2026-07-23T00:00:00Z"),
  };
}

const HOURLY_PROGRAM: ProgramPayConfig = {
  payMode: "hourly",
  defaultRatePer30MinCents: 1500, // $30/hr
  defaultPerSessionRateCents: null,
};
// A flat $100 per game, however long the game runs.
const PER_SESSION_PROGRAM: ProgramPayConfig = {
  payMode: "per_session",
  defaultRatePer30MinCents: 2500, // stale leftover — must NOT be used
  defaultPerSessionRateCents: 10_000,
};

describe("pre-0052 behavior is preserved for hourly programs", () => {
  it("no override → the program's hourly default, no per-session snapshot", () => {
    expect(resolveRateCentsForProgram(null, HOURLY_PROGRAM)).toBe(1500);
    expect(resolvePerSessionRateCents(null, HOURLY_PROGRAM)).toBeNull();
  });

  it("hourly override wins over the program default", () => {
    const o = override({ payMode: "hourly", ratePer30MinCents: 2000 });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM)).toBe(2000);
    expect(resolvePerSessionRateCents(o, HOURLY_PROGRAM)).toBeNull();
  });

  it("per-session override wins, and still falls through to the program's hourly default", () => {
    // Unchanged from before 0052: the hourly snapshot is harmless because
    // workPayForLog prefers the per-session amount. Kept identical so this
    // change re-prices NOTHING on deploy.
    const o = override({ payMode: "per_session", perSessionRateCents: 7500 });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM)).toBe(1500);
    expect(resolvePerSessionRateCents(o, HOURLY_PROGRAM)).toBe(7500);
  });

  it("a program with no rate at all resolves to $0, never a guess", () => {
    const bare: ProgramPayConfig = {
      payMode: "hourly",
      defaultRatePer30MinCents: null,
      defaultPerSessionRateCents: null,
    };
    expect(resolveRateCentsForProgram(null, bare)).toBeNull();
    expect(resolvePerSessionRateCents(null, bare)).toBeNull();
  });
});

describe("0052: program-level per-session pay", () => {
  it("no override → the program's flat per-session amount, and NO hourly basis", () => {
    expect(resolvePerSessionRateCents(null, PER_SESSION_PROGRAM)).toBe(10_000);
    // The stale hourly default must not leak onto the row.
    expect(resolveRateCentsForProgram(null, PER_SESSION_PROGRAM)).toBeNull();
  });

  it("pays the SAME flat amount no matter how long the session ran — the actual bug", () => {
    const perSessionRateCents = resolvePerSessionRateCents(
      null,
      PER_SESSION_PROGRAM,
    );
    const ratePer30MinCents = resolveRateCentsForProgram(
      null,
      PER_SESSION_PROGRAM,
    );
    const pay = (hours: number) =>
      workPayForLog({
        perSessionRateCents,
        ratePer30MinCents,
        startAt: new Date("2026-07-11T17:00:00Z"),
        endAt: new Date(Date.parse("2026-07-11T17:00:00Z") + hours * 3_600_000),
      });

    // A 2-hour game and a 3.5-hour game both pay exactly $100. Under the old
    // hourly fake at $100/hr these paid $200 and $350.
    expect(pay(2)).toBe(10_000);
    expect(pay(3.5)).toBe(10_000);
    expect(pay(9.5)).toBe(10_000);
  });

  it("a per-session program with no amount set pays $0 — loud, not silently hourly", () => {
    const unset: ProgramPayConfig = {
      payMode: "per_session",
      defaultRatePer30MinCents: 2500,
      defaultPerSessionRateCents: null,
    };
    expect(resolvePerSessionRateCents(null, unset)).toBeNull();
    expect(resolveRateCentsForProgram(null, unset)).toBeNull();
  });

  it("rejects a non-positive or non-integer per-session amount", () => {
    for (const bad of [0, -1, 10.5, null]) {
      const p: ProgramPayConfig = {
        payMode: "per_session",
        defaultRatePer30MinCents: null,
        defaultPerSessionRateCents: bad as number | null,
      };
      expect(resolvePerSessionRateCents(null, p)).toBeNull();
    }
  });
});

describe("precedence: a coach override always beats the program default", () => {
  it("an HOURLY override on a PER-SESSION program keeps that coach on the clock", () => {
    // This is the operational trap: flipping a program to per-session does
    // NOT reach coaches holding an hourly override. The Work tab warns.
    const o = override({ payMode: "hourly", ratePer30MinCents: 2500 });
    expect(resolveRateCentsForProgram(o, PER_SESSION_PROGRAM)).toBe(2500);
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM)).toBeNull();

    const pay = workPayForLog({
      perSessionRateCents: resolvePerSessionRateCents(o, PER_SESSION_PROGRAM),
      ratePer30MinCents: resolveRateCentsForProgram(o, PER_SESSION_PROGRAM),
      startAt: new Date("2026-07-11T17:00:00Z"),
      endAt: new Date("2026-07-11T20:30:00Z"), // 3.5h
    });
    expect(pay).toBe(17_500); // 3.5h x $50/hr — NOT the $100 flat fee
  });

  it("a coach's per-session override beats the program's per-session amount", () => {
    const o = override({ payMode: "per_session", perSessionRateCents: 12_500 });
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM)).toBe(12_500);
  });

  it("a per-session override with an INVALID amount does not fall back to the program's amount", () => {
    // Preserves pre-0052 behavior: an unusable override amount yields null
    // rather than silently reaching past the coach's own setting.
    const o = override({ payMode: "per_session", perSessionRateCents: 0 });
    expect(resolvePerSessionRateCents(o, PER_SESSION_PROGRAM)).toBeNull();
  });

  it("an hourly override with no rate set falls through to the program", () => {
    const o = override({ payMode: "hourly", ratePer30MinCents: null });
    expect(resolveRateCentsForProgram(o, HOURLY_PROGRAM)).toBe(1500);
  });
});
