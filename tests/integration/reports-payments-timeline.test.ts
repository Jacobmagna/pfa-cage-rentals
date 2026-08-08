// Integration coverage for the Reports "Payments" timeline (reports-tabs
// SPEC Phase D), against a real Neon dev branch.
//
// What only a real DB can prove here:
//
//   1. 🔴 THE TIMEZONE ROUND TRIP. `audit_log.ts` is `timestamp` WITHOUT
//      time zone. The timeline sorts and displays by it, so if Drizzle
//      hands back an instant shifted by the runner's offset, every
//      timestamp on a money screen is wrong — and wrong only off-UTC,
//      which is every machine except Vercel. This bug class has bitten
//      this repo twice. Tested by writing a known instant and reading it
//      back, plus boundary rows either side of the range.
//   2. The real audit rows the REAL payment actions write are shaped the
//      way the pure module assumes — create/update/delete, and confirm
//      logged as an `update`. A fixture-only test would happily encode a
//      wrong assumption.
//   3. The coach filter and the entityType scope actually narrow.
//
// truncateMutables() TRUNCATEs coach_payments and audit_log, so this file
// gets a clean slate per test and does not need its own id bookkeeping.

import { beforeEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, coachPayments } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import {
  confirmPaymentInternal,
  createPaymentInternal,
  deletePaymentInternal,
  updatePaymentInternal,
} from "@/lib/server/payment-actions";
import { buildPaymentTimeline } from "@/lib/reports/payments-timeline";
import { fetchPaymentTimelineRows } from "@/lib/reports/payments-timeline-fetch";
import { ensureFixtureUsers, truncateMutables, type FixtureUsers } from "./fixtures";

let fixtures: FixtureUsers;
let admin: FixtureUsers["admin"];

const PAID_AT = new Date("2026-08-03T19:00:00Z");

// A wide window around "now" — audit rows stamp themselves with
// defaultNow(), so the range has to contain the moment of the test run.
const fromDate = new Date(Date.now() - 2 * 24 * 3_600_000);
const toDateExclusive = new Date(Date.now() + 2 * 24 * 3_600_000);

function filters(coachIds: string[] = []) {
  return { fromDate, toDateExclusive, coachIds };
}

async function timeline(coachIds: string[] = []) {
  const result = await fetchPaymentTimelineRows(filters(coachIds));
  return { ...buildPaymentTimeline(result.rows), truncated: result.truncated };
}

function paymentInput(coachId: string, overrides: Record<string, unknown> = {}) {
  return {
    coachId,
    amountCents: 180000,
    method: "check",
    direction: "coach_to_pfa",
    paidAt: PAID_AT,
    ...overrides,
  };
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  admin = fixtures.admin;
});

beforeEach(async () => {
  await truncateMutables();
});

describe("payments timeline — real audit rows from the real actions", () => {
  it("records a create as a 'recorded' event", async () => {
    await createPaymentInternal(admin, paymentInput(fixtures.coach.id));
    const { events } = await timeline();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("recorded");
    expect(events[0].amountCents).toBe(180000);
    expect(events[0].direction).toBe("coach_to_pfa");
    expect(events[0].coachLabel).toBe("Integration Coach");
    expect(events[0].actorLabel).toBe("Integration Admin");
  });

  it("records an update as an 'edited' event with the change described", async () => {
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    await updatePaymentInternal(admin, created.id, {
      direction: "pfa_to_coach",
    });

    const { events } = await timeline();
    expect(events).toHaveLength(2);
    // Newest first.
    expect(events[0].kind).toBe("edited");
    expect(events[0].changes).toContainEqual({
      label: "Direction",
      from: "Coach paid PFA",
      to: "PFA paid coach",
    });
    expect(events[1].kind).toBe("recorded");
  });

  it("distinguishes a CONFIRM from an edit, though both log as 'update'", async () => {
    // This is the assumption the pure module rests on. If confirm ever
    // stops moving status, or starts logging its own action, this fails
    // here rather than mislabelling rows on a money screen.
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
      { status: "pending" },
    );
    await confirmPaymentInternal(admin, created.id);

    const raw = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "payment"),
          eq(auditLog.entityId, created.id),
        ),
      );
    // Confirm really is logged as an `update` — the premise.
    expect(raw.map((r) => r.action).sort()).toEqual(["create", "update"]);

    const { events } = await timeline();
    expect(events[0].kind).toBe("confirmed");
  });

  it("records a delete, marks the payment deleted, and blocks editing", async () => {
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    await deletePaymentInternal(admin, created.id);

    const { events } = await timeline();
    expect(events[0].kind).toBe("deleted");
    // Every event for this payment now reports it deleted, so no row can
    // offer an edit the server would refuse.
    expect(events.every((e) => e.paymentDeleted)).toBe(true);
  });

  it("still reports the amount of a deleted payment", async () => {
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    await deletePaymentInternal(admin, created.id);
    const { events } = await timeline();
    expect(events[0].amountCents).toBe(180000);
  });
});

describe("payments timeline — 🔴 timezone round trip", () => {
  it("reads back the exact instant it was written", async () => {
    // audit_log.ts is `timestamp` WITHOUT time zone. If Drizzle's mapping
    // shifted by the runner's offset, this is off by hours.
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    const written = new Date("2026-08-03T21:14:00.000Z");
    await db
      .update(auditLog)
      .set({ ts: written })
      .where(eq(auditLog.entityId, created.id));

    // An explicit window around the FIXED instant — the default range is
    // relative to now, which would exclude it.
    const result = await fetchPaymentTimelineRows({
      fromDate: new Date("2026-08-01T00:00:00Z"),
      toDateExclusive: new Date("2026-08-05T00:00:00Z"),
      coachIds: [],
    });
    const { events } = buildPaymentTimeline(result.rows);
    expect(events).toHaveLength(1);
    expect(events[0].ts.toISOString()).toBe("2026-08-03T21:14:00.000Z");
    expect(events[0].ts.getTime()).toBe(written.getTime());
  });

  it("filters the range on the same instants it displays", async () => {
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    // Push the event a week past the window's upper bound.
    await db
      .update(auditLog)
      .set({ ts: new Date(toDateExclusive.getTime() + 7 * 24 * 3_600_000) })
      .where(eq(auditLog.entityId, created.id));
    expect((await timeline()).events).toHaveLength(0);

    // One millisecond inside the upper bound → included.
    await db
      .update(auditLog)
      .set({ ts: new Date(toDateExclusive.getTime() - 1) })
      .where(eq(auditLog.entityId, created.id));
    expect((await timeline()).events).toHaveLength(1);

    // Exactly ON the exclusive upper bound → excluded.
    await db
      .update(auditLog)
      .set({ ts: toDateExclusive })
      .where(eq(auditLog.entityId, created.id));
    expect((await timeline()).events).toHaveLength(0);

    // Exactly ON the inclusive lower bound → included.
    await db
      .update(auditLog)
      .set({ ts: fromDate })
      .where(eq(auditLog.entityId, created.id));
    expect((await timeline()).events).toHaveLength(1);
  });

  it("orders newest first by the stored instant", async () => {
    const a = await createPaymentInternal(admin, paymentInput(fixtures.coach.id));
    const b = await createPaymentInternal(admin, paymentInput(fixtures.coach.id));
    await db
      .update(auditLog)
      .set({ ts: new Date("2026-08-01T10:00:00Z") })
      .where(eq(auditLog.entityId, a.id));
    await db
      .update(auditLog)
      .set({ ts: new Date("2026-08-02T10:00:00Z") })
      .where(eq(auditLog.entityId, b.id));

    // Widen so both fixed dates fall inside.
    const result = await fetchPaymentTimelineRows({
      fromDate: new Date("2026-07-01T00:00:00Z"),
      toDateExclusive: new Date("2026-09-01T00:00:00Z"),
      coachIds: [],
    });
    const { events } = buildPaymentTimeline(result.rows);
    expect(events.map((e) => e.paymentId)).toEqual([b.id, a.id]);
  });
});

describe("payments timeline — scope and filters", () => {
  it("respects the coach filter", async () => {
    await createPaymentInternal(admin, paymentInput(fixtures.coach.id));
    await createPaymentInternal(admin, paymentInput(fixtures.flaggedCoach.id));

    expect((await timeline()).events).toHaveLength(2);
    const mine = await timeline([fixtures.coach.id]);
    expect(mine.events).toHaveLength(1);
    expect(mine.events[0].coachLabel).toBe("Integration Coach");
  });

  it("includes ONLY payment events, not the rest of the audit log", async () => {
    await createPaymentInternal(admin, paymentInput(fixtures.coach.id));
    // A non-payment audit row in the same window must not appear —
    // v1 is payments only (SPEC §11 decision 3).
    await logAudit(db, {
      actorUserId: admin.id,
      entityType: "hour_log",
      entityId: "some-log-id",
      action: "update",
      before: { a: 1 },
      after: { a: 2 },
    });

    const { events } = await timeline();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("recorded");
  });

  it("totals only recorded events, so an edited payment counts once", async () => {
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    await updatePaymentInternal(admin, created.id, { amountCents: 190000 });
    await deletePaymentInternal(admin, created.id);

    const { events, totals } = await timeline();
    expect(events).toHaveLength(3);
    expect(totals.recordedCount).toBe(1);
    expect(totals.recordedCoachToPfaCents).toBe(180000);
    expect(totals.recordedSinceDeletedCount).toBe(1);
  });

  it("splits the two directions without netting them", async () => {
    await createPaymentInternal(admin, paymentInput(fixtures.coach.id));
    await createPaymentInternal(
      admin,
      paymentInput(fixtures.flaggedCoach.id, {
        amountCents: 4000,
        direction: "pfa_to_coach",
      }),
    );
    const { totals } = await timeline();
    expect(totals.recordedCoachToPfaCents).toBe(180000);
    expect(totals.recordedPfaToCoachCents).toBe(4000);
  });

  it("exposes live payment values for the edit dialog", async () => {
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    await updatePaymentInternal(admin, created.id, { amountCents: 190000 });

    const { events } = await timeline();
    const latest = events[0];
    expect(latest.isLatestInRange).toBe(true);
    // The dialog opens on CURRENT state, not the historical snapshot.
    expect(latest.current?.amountCents).toBe(190000);
    expect(latest.current?.id).toBe(created.id);
    // …and only the newest row carries the affordance.
    expect(events.slice(1).every((e) => !e.isLatestInRange)).toBe(true);
  });

  it("reports an empty range without error", async () => {
    const result = await fetchPaymentTimelineRows({
      fromDate: new Date("2020-01-01T00:00:00Z"),
      toDateExclusive: new Date("2020-01-02T00:00:00Z"),
      coachIds: [],
    });
    const { events, totals } = buildPaymentTimeline(result.rows);
    expect(events).toEqual([]);
    expect(totals.recordedCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("leaves the payment ledger untouched — this tab only READS", async () => {
    const created = await createPaymentInternal(
      admin,
      paymentInput(fixtures.coach.id),
    );
    await timeline();
    const [after] = await db
      .select()
      .from(coachPayments)
      .where(eq(coachPayments.id, created.id));
    expect(after.amountCents).toBe(180000);
    expect(after.deletedAt).toBeNull();
  });
});
