// Unit tests for the stipend CARD's form-action layer (SPEC §6, Phase C).
//
// 🔴 WHAT THIS FILE IS ACTUALLY PROTECTING: the §12.4 back-pay confirmation.
//
// The server refuses a backdated stipend and the card is supposed to render
// that refusal as a DECISION — an amber panel naming the affected periods and
// the money, with a separate "yes, apply it" submit — rather than as a red
// validation error. That distinction lives entirely in this translate layer.
// If a `BACKDATE_NOT_CONFIRMED` ever falls through to the generic error branch
// the app still refuses the write (the planner is the real control), but the
// admin sees "something went wrong" instead of "this is back-pay worth $5,000,
// some of which Mark may already have paid in cash" — and the whole point of
// the guard is that a human reads it.
//
// The underlying `./actions` module is mocked: it pulls in `@/db` and
// next-auth, and what is under test here is the translation, not the write.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { StipendPlanError } from "@/lib/stipend/engine";
import { payPeriodFor } from "@/lib/pay-period";
import { parsePfaInput } from "@/lib/timezone";

const setCoachStipend = vi.hoisted(() => vi.fn());
const endCoachStipend = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({ setCoachStipend, endCoachStipend }));

const { setCoachStipendFormAction, endCoachStipendFormAction } = await import(
  "./stipend-form-actions"
);

const OK = { ok: true } as const;

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const VALID = {
  coachId: "coach-1",
  amount: "2500",
  effectiveFrom: "2026-09-01",
  note: "",
};

beforeEach(() => {
  setCoachStipend.mockReset();
  endCoachStipend.mockReset();
});

describe("setCoachStipendFormAction — the happy path", () => {
  it("converts dollars to cents and a date-only string to a PFA instant", async () => {
    setCoachStipend.mockResolvedValue({ row: { coachId: "coach-1" } });

    const res = await setCoachStipendFormAction(OK, form(VALID));
    expect(res.ok).toBe(true);

    const arg = setCoachStipend.mock.calls[0][0];
    expect(arg.amountCents).toBe(250_000);
    expect(arg.coachId).toBe("coach-1");
    expect(arg.note).toBeNull();
    expect(arg.confirmBackdate).toBe(false);

    // 🔴 The date must land on PFA midnight, NOT UTC midnight. `new Date(
    // "2026-09-01")` is 00:00Z, which is 5pm on Aug 31 in PFA — a whole pay
    // period early. This asserts the actual instant, not just that a Date
    // came out.
    expect(arg.effectiveFrom.toISOString()).toBe("2026-09-01T07:00:00.000Z");
    expect(payPeriodFor(arg.effectiveFrom).key).toBe("2026-09-P1");
  });

  it("passes a trimmed note through, and null for an empty one", async () => {
    setCoachStipend.mockResolvedValue({ row: { coachId: "coach-1" } });
    await setCoachStipendFormAction(
      OK,
      form({ ...VALID, note: "  Manager work  " }),
    );
    expect(setCoachStipend.mock.calls[0][0].note).toBe("Manager work");
  });

  it("forwards the confirmation flag only when it is actually set", async () => {
    setCoachStipend.mockResolvedValue({ row: { coachId: "coach-1" } });
    await setCoachStipendFormAction(
      OK,
      form({ ...VALID, confirmBackdate: "true" }),
    );
    expect(setCoachStipend.mock.calls[0][0].confirmBackdate).toBe(true);
  });
});

describe("🔴 the §12.4 back-pay refusal becomes a CONFIRMATION, not an error", () => {
  it("returns needsBackdateConfirm with the periods and the message", async () => {
    const periods = [
      payPeriodFor(parsePfaInput("2026-08-01", "12:00")),
      payPeriodFor(parsePfaInput("2026-08-20", "12:00")),
    ];
    setCoachStipend.mockRejectedValue(
      new StipendPlanError(
        "BACKDATE_NOT_CONFIRMED",
        "This starts the stipend in 2 pay periods … up to $5000.00 …",
        periods,
      ),
    );

    const res = await setCoachStipendFormAction(
      OK,
      form({ ...VALID, effectiveFrom: "2026-08-01" }),
    );

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    // 🔴 The whole point: this is NOT the generic error shape.
    expect(res.needsBackdateConfirm).toBe(true);
    if (res.needsBackdateConfirm !== true) throw new Error("unreachable");
    expect(res.periodKeys).toEqual(["2026-08-P1", "2026-08-P2"]);
    expect(res.message).toContain("$5000.00");
    // The typed amount survives so the confirm button re-submits the SAME
    // number the admin is being asked to approve.
    expect(res.values.amount).toBe("2500");
    expect(res.values.effectiveFrom).toBe("2026-08-01");
  });

  it("does NOT set needsBackdateConfirm on any other plan refusal", async () => {
    // The positive control for the branch above. Without it, a translate layer
    // that marked EVERY StipendPlanError as a confirmation would pass the test
    // above and quietly offer an "apply anyway" button for a $0 amount.
    for (const code of [
      "NOT_PERIOD_START",
      "NOT_FORWARD_ONLY",
      "AMOUNT_NOT_POSITIVE",
      "NO_OPEN_VERSION",
    ] as const) {
      setCoachStipend.mockRejectedValue(
        new StipendPlanError(code, `refused: ${code}`),
      );
      const res = await setCoachStipendFormAction(OK, form(VALID));
      expect(res.ok).toBe(false);
      if (res.ok) throw new Error("unreachable");
      expect(res.needsBackdateConfirm).not.toBe(true);
      if (res.needsBackdateConfirm === true) throw new Error("unreachable");
      expect(res.error.code).toBe(code);
      expect(res.error.message).toBe(`refused: ${code}`);
    }
  });
});

describe("setCoachStipendFormAction — input the server never sees", () => {
  it("refuses an unparseable amount before calling the action", async () => {
    const res = await setCoachStipendFormAction(
      OK,
      form({ ...VALID, amount: "two thousand" }),
    );
    expect(res.ok).toBe(false);
    expect(setCoachStipend).not.toHaveBeenCalled();
  });

  it("refuses a missing or malformed date before calling the action", async () => {
    for (const bad of ["", "09/01/2026", "2026-9-1"]) {
      const res = await setCoachStipendFormAction(
        OK,
        form({ ...VALID, effectiveFrom: bad }),
      );
      expect(res.ok, `expected refusal for ${JSON.stringify(bad)}`).toBe(false);
    }
    expect(setCoachStipend).not.toHaveBeenCalled();
  });

  it("refuses a missing coach id", async () => {
    const fd = form(VALID);
    fd.delete("coachId");
    const res = await setCoachStipendFormAction(OK, fd);
    expect(res.ok).toBe(false);
    expect(setCoachStipend).not.toHaveBeenCalled();
  });

  it("preserves what the admin typed on a failure, so the form is not blanked", async () => {
    const res = await setCoachStipendFormAction(
      OK,
      form({ ...VALID, amount: "nope", note: "keep me" }),
    );
    if (res.ok) throw new Error("unreachable");
    expect(res.values.amount).toBe("nope");
    expect(res.values.note).toBe("keep me");
    expect(res.values.effectiveFrom).toBe("2026-09-01");
  });
});

describe("endCoachStipendFormAction", () => {
  it("parses the end date as a PFA instant", async () => {
    endCoachStipend.mockResolvedValue({ row: { coachId: "coach-1" } });
    const res = await endCoachStipendFormAction(
      OK,
      form({ coachId: "coach-1", effectiveTo: "2026-10-01" }),
    );
    expect(res.ok).toBe(true);
    expect(endCoachStipend.mock.calls[0][0].effectiveTo.toISOString()).toBe(
      "2026-10-01T07:00:00.000Z",
    );
  });

  it("surfaces a retroactive END as a confirmation too", async () => {
    endCoachStipend.mockRejectedValue(
      new StipendPlanError("BACKDATE_NOT_CONFIRMED", "already under way", [
        payPeriodFor(parsePfaInput("2026-08-20", "12:00")),
      ]),
    );
    const res = await endCoachStipendFormAction(
      OK,
      form({ coachId: "coach-1", effectiveTo: "2026-08-16" }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.needsBackdateConfirm).toBe(true);
  });

  it("refuses a malformed end date before calling the action", async () => {
    const res = await endCoachStipendFormAction(
      OK,
      form({ coachId: "coach-1", effectiveTo: "soon" }),
    );
    expect(res.ok).toBe(false);
    expect(endCoachStipend).not.toHaveBeenCalled();
  });
});
