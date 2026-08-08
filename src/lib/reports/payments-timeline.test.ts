// Unit tests for the payments-timeline shaping. Pure module → no mocks.
//
// The two subtle things under test, both consequences of how payments are
// audited rather than of anything this module invents:
//
//   1. CONFIRM is logged as `action: "update"`, so "confirmed" and
//      "edited" have to be separated by inspecting the diff.
//   2. An update diff is CHANGED-KEYS-ONLY, so an event's own payload
//      often lacks the amount and the coach — they have to fall back to
//      the joined payment row without ever inventing a number.

import { describe, expect, it } from "vitest";
import {
  buildPaymentTimeline,
  deriveEventKind,
  type PaymentAuditRow,
} from "./payments-timeline";

const PAID_AT = new Date("2026-08-03T19:00:00Z");
const TS = new Date("2026-08-03T21:14:00Z");

function row(overrides: Partial<PaymentAuditRow> = {}): PaymentAuditRow {
  return {
    id: "audit-1",
    ts: TS,
    action: "create",
    entityId: "pay-1",
    diff: { after: { amountCents: 180000, direction: "coach_to_pfa" } },
    actorName: "Mark",
    actorEmail: "mark@example.com",
    coachName: "David Lusk",
    coachEmail: "david@example.com",
    paymentAmountCents: 180000,
    paymentDirection: "coach_to_pfa",
    paymentDeletedAt: null,
    paymentCoachId: "coach-1",
    paymentMethod: "check",
    paymentPaidAt: PAID_AT,
    paymentReference: null,
    paymentNote: null,
    ...overrides,
  };
}

describe("deriveEventKind", () => {
  it("maps create to recorded and delete to deleted", () => {
    expect(deriveEventKind("create", {}, {})).toBe("recorded");
    expect(deriveEventKind("delete", {}, {})).toBe("deleted");
  });

  it("reads an update that moved status INTO confirmed as a confirm", () => {
    expect(
      deriveEventKind(
        "update",
        { status: "pending" },
        { status: "confirmed" },
      ),
    ).toBe("confirmed");
  });

  it("reads any other update as an edit", () => {
    expect(
      deriveEventKind("update", { amountCents: 100 }, { amountCents: 200 }),
    ).toBe("edited");
  });

  it("does NOT call an edit a confirm just because status is present", () => {
    // A hypothetical diff where status appears on both sides unchanged
    // must not be mistaken for a confirmation.
    expect(
      deriveEventKind(
        "update",
        { status: "confirmed", amountCents: 100 },
        { status: "confirmed", amountCents: 200 },
      ),
    ).toBe("edited");
  });
});

describe("buildPaymentTimeline — event shaping", () => {
  it("labels actor and coach from the joined names", () => {
    const { events } = buildPaymentTimeline([row()]);
    expect(events[0].actorLabel).toBe("Mark");
    expect(events[0].coachLabel).toBe("David Lusk");
  });

  it("falls back to emails when names are null", () => {
    const { events } = buildPaymentTimeline([
      row({ actorName: null, coachName: null }),
    ]);
    expect(events[0].actorLabel).toBe("mark@example.com");
    expect(events[0].coachLabel).toBe("david@example.com");
  });

  it("degrades to a placeholder when the join found nothing", () => {
    const { events } = buildPaymentTimeline([
      row({
        actorName: null,
        actorEmail: null,
        coachName: null,
        coachEmail: null,
      }),
    ]);
    expect(events[0].actorLabel).toBe("Unknown");
    expect(events[0].coachLabel).toBe("Unknown coach");
  });

  it("prefers the event's OWN amount over the payment's current one", () => {
    // The payment was later edited to $50; the create event must still
    // report the $1,800 it recorded.
    const { events } = buildPaymentTimeline([
      row({
        diff: { after: { amountCents: 180000 } },
        paymentAmountCents: 5000,
      }),
    ]);
    expect(events[0].amountCents).toBe(180000);
  });

  it("falls back to the payment's amount when the diff has none", () => {
    // A confirm carries only status/confirmedBy/confirmedAt.
    const { events } = buildPaymentTimeline([
      row({
        action: "update",
        diff: { before: { status: "pending" }, after: { status: "confirmed" } },
        paymentAmountCents: 4200,
      }),
    ]);
    expect(events[0].kind).toBe("confirmed");
    expect(events[0].amountCents).toBe(4200);
  });

  it("reports a null amount rather than inventing one", () => {
    const { events } = buildPaymentTimeline([
      row({ diff: {}, paymentAmountCents: null }),
    ]);
    expect(events[0].amountCents).toBeNull();
  });

  it("describes what changed on an edit", () => {
    const { events } = buildPaymentTimeline([
      row({
        action: "update",
        diff: {
          before: { direction: "coach_to_pfa" },
          after: { direction: "pfa_to_coach" },
        },
      }),
    ]);
    expect(events[0].kind).toBe("edited");
    expect(events[0].changes).toEqual([
      { label: "Direction", from: "Coach paid PFA", to: "PFA paid coach" },
    ]);
  });

  it("formats an amount change as money", () => {
    const { events } = buildPaymentTimeline([
      row({
        action: "update",
        diff: {
          before: { amountCents: 180000 },
          after: { amountCents: 190050 },
        },
      }),
    ]);
    expect(events[0].changes).toEqual([
      { label: "Amount", from: "$1,800.00", to: "$1,900.50" },
    ]);
  });

  it("does not attach a change list to non-edit events", () => {
    const { events } = buildPaymentTimeline([row({ action: "create" })]);
    expect(events[0].changes).toEqual([]);
  });

  it("survives a malformed diff without throwing", () => {
    // `diff` is jsonb typed as unknown and written by four call sites —
    // a bad payload must degrade to "no detail", not take the page down.
    for (const diff of [null, undefined, "nonsense", 42, [], { after: 7 }]) {
      expect(() => buildPaymentTimeline([row({ diff })])).not.toThrow();
    }
  });

  it("marks an event whose payment has since been deleted", () => {
    const { events } = buildPaymentTimeline([
      row({ paymentDeletedAt: new Date("2026-08-05T00:00:00Z") }),
    ]);
    expect(events[0].paymentDeleted).toBe(true);
  });
});

describe("buildPaymentTimeline — the edit affordance anchors to current state", () => {
  it("flags only the NEWEST event of a payment", () => {
    // Rows arrive newest-first.
    const { events } = buildPaymentTimeline([
      row({ id: "a3", action: "update", diff: { before: {}, after: {} } }),
      row({ id: "a2", action: "update", diff: { before: {}, after: {} } }),
      row({ id: "a1", action: "create" }),
    ]);
    expect(events.map((e) => e.isLatestInRange)).toEqual([true, false, false]);
  });

  it("flags the newest event of EACH payment independently", () => {
    const { events } = buildPaymentTimeline([
      row({ id: "b2", entityId: "pay-2", action: "update", diff: {} }),
      row({ id: "a2", entityId: "pay-1", action: "update", diff: {} }),
      row({ id: "b1", entityId: "pay-2", action: "create" }),
      row({ id: "a1", entityId: "pay-1", action: "create" }),
    ]);
    expect(events.map((e) => [e.id, e.isLatestInRange])).toEqual([
      ["b2", true],
      ["a2", true],
      ["b1", false],
      ["a1", false],
    ]);
  });

  it("exposes the payment's LIVE values for the dialog, not the snapshot", () => {
    const { events } = buildPaymentTimeline([
      row({
        diff: { after: { amountCents: 180000 } },
        paymentAmountCents: 5000,
        paymentCoachId: "coach-9",
      }),
    ]);
    // The row displays the historical amount…
    expect(events[0].amountCents).toBe(180000);
    // …but the edit form must open on current state.
    expect(events[0].current?.amountCents).toBe(5000);
    expect(events[0].current?.coachId).toBe("coach-9");
  });

  it("has no editable payload when the payment row did not join", () => {
    const { events } = buildPaymentTimeline([
      row({
        paymentCoachId: null,
        paymentAmountCents: null,
        paymentMethod: null,
        paymentDirection: null,
        paymentPaidAt: null,
      }),
    ]);
    expect(events[0].current).toBeNull();
  });
});

describe("buildPaymentTimeline — totals", () => {
  it("counts ONLY recorded events, so a payment is never multi-counted", () => {
    // One payment, recorded then edited then confirmed in the window.
    const { totals } = buildPaymentTimeline([
      row({
        id: "c",
        action: "update",
        diff: { before: { status: "pending" }, after: { status: "confirmed" } },
      }),
      row({
        id: "b",
        action: "update",
        diff: { before: { note: "x" }, after: { note: "y" } },
      }),
      row({ id: "a", action: "create" }),
    ]);
    expect(totals.recordedCount).toBe(1);
    expect(totals.recordedCoachToPfaCents).toBe(180000);
  });

  it("splits the two directions and NEVER nets them", () => {
    const { totals } = buildPaymentTimeline([
      row({
        id: "in",
        entityId: "p1",
        diff: { after: { amountCents: 10000, direction: "coach_to_pfa" } },
      }),
      row({
        id: "out",
        entityId: "p2",
        diff: { after: { amountCents: 4000, direction: "pfa_to_coach" } },
      }),
    ]);
    expect(totals.recordedCoachToPfaCents).toBe(10000);
    expect(totals.recordedPfaToCoachCents).toBe(4000);
    // The netted figure ($60) must appear nowhere.
    expect(totals).not.toHaveProperty("netCents");
  });

  it("counts a since-deleted payment but reports how many", () => {
    const { totals } = buildPaymentTimeline([
      row({
        id: "live",
        entityId: "p1",
        diff: { after: { amountCents: 10000, direction: "coach_to_pfa" } },
      }),
      row({
        id: "gone",
        entityId: "p2",
        diff: { after: { amountCents: 2500, direction: "coach_to_pfa" } },
        paymentDeletedAt: new Date("2026-08-06T00:00:00Z"),
      }),
    ]);
    expect(totals.recordedCoachToPfaCents).toBe(12500);
    expect(totals.recordedCount).toBe(2);
    expect(totals.recordedSinceDeletedCount).toBe(1);
  });

  it("skips a recorded event with no resolvable amount", () => {
    const { totals } = buildPaymentTimeline([
      row({ diff: {}, paymentAmountCents: null, paymentDirection: null }),
    ]);
    expect(totals.recordedCount).toBe(1);
    expect(totals.recordedCoachToPfaCents).toBe(0);
    expect(totals.recordedPfaToCoachCents).toBe(0);
  });

  it("is all zeroes for an empty range", () => {
    const { events, totals } = buildPaymentTimeline([]);
    expect(events).toEqual([]);
    expect(totals).toEqual({
      recordedCoachToPfaCents: 0,
      recordedPfaToCoachCents: 0,
      recordedCount: 0,
      recordedSinceDeletedCount: 0,
    });
  });

  it("the totals are reproducible from the recorded rows on screen", () => {
    // The property that matters: a reader adding up the "Recorded" rows
    // must land on the number printed above them.
    const rows = [
      row({
        id: "1",
        entityId: "p1",
        diff: { after: { amountCents: 10000, direction: "coach_to_pfa" } },
      }),
      row({
        id: "2",
        entityId: "p2",
        diff: { after: { amountCents: 2500, direction: "coach_to_pfa" } },
      }),
      row({ id: "3", entityId: "p2", action: "update", diff: {} }),
    ];
    const { events, totals } = buildPaymentTimeline(rows);
    const onScreen = events
      .filter((e) => e.kind === "recorded" && e.direction === "coach_to_pfa")
      .reduce((n, e) => n + (e.amountCents ?? 0), 0);
    expect(onScreen).toBe(totals.recordedCoachToPfaCents);
  });
});

describe("buildPaymentTimeline — no-op change rows are suppressed", () => {
  it("drops a change that renders identically on both sides", () => {
    // Caught by a SCREENSHOT, not an assertion: re-saving a payment from
    // the date-picker dialog moves paidAt's instant without moving the
    // day anyone can see, producing "Paid on: 2026-08-08 → 2026-08-08".
    const { events } = buildPaymentTimeline([
      row({
        action: "update",
        diff: {
          before: { paidAt: "2026-08-08T19:00:00.000Z" },
          after: { paidAt: "2026-08-08T07:00:00.000Z" },
        },
      }),
    ]);
    expect(events[0].kind).toBe("edited");
    expect(events[0].changes).toEqual([]);
  });

  it("still reports a paidAt change that crosses a PFA day", () => {
    const { events } = buildPaymentTimeline([
      row({
        action: "update",
        diff: {
          before: { paidAt: "2026-08-08T19:00:00.000Z" },
          after: { paidAt: "2026-08-10T19:00:00.000Z" },
        },
      }),
    ]);
    expect(events[0].changes).toEqual([
      { label: "Paid on", from: "2026-08-08", to: "2026-08-10" },
    ]);
  });

  it("keeps the real changes when a no-op rides alongside one", () => {
    const { events } = buildPaymentTimeline([
      row({
        action: "update",
        diff: {
          before: { amountCents: 180000, paidAt: "2026-08-08T19:00:00.000Z" },
          after: { amountCents: 175025, paidAt: "2026-08-08T07:00:00.000Z" },
        },
      }),
    ]);
    expect(events[0].changes).toEqual([
      { label: "Amount", from: "$1,800.00", to: "$1,750.25" },
    ]);
  });

  it("suppresses an empty-to-empty note change", () => {
    const { events } = buildPaymentTimeline([
      row({
        action: "update",
        diff: { before: { note: "" }, after: { note: null } },
      }),
    ]);
    expect(events[0].changes).toEqual([]);
  });
});
