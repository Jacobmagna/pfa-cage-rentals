// payment-statement SPEC §12.1 / §12.3 — THE FORM-ACTION BOUNDARY.
//
// 🔴 Why this file exists. SPEC §12.1 names its bug site precisely: *"if
// `buildInput` omits `coversThrough` when the input is blank"*, Mark can set a
// coverage date and never clear it, because `updatePaymentSchema` is
// `createPaymentSchema.partial()` where an OMITTED key means "leave unchanged".
// The integration tests prove `updatePaymentInternal` honours an explicit
// `null` — which is the half that was never at risk. Nothing anywhere
// exercised `buildInput`, `snapshot`, `recordPaymentFormAction` or
// `updatePaymentFormAction`, so a regression that dropped the key from the
// object would have been GREEN everywhere and silently un-clearable in prod.
//
// So this drives the two form actions with REAL `FormData`, exactly the shape
// the dialog submits, and asserts the object that reaches the mutation. The
// mutations themselves are mocked: this is a test of the TRANSLATION layer, and
// mocking `./actions` keeps `next/cache` and the DB out of a unit run.
//
// The three cases §12.1 turns on, spelled out because they are easy to conflate:
//   · blank field   → the key is PRESENT with value `null`   (clears)
//   · absent key    → the key is PRESENT with value `null`   (clears)
//   · a real date   → PFA-midnight of that day, same convention as `paidAt`
//
// `snapshot` gets its own block for §12.3: a failed save must re-render every
// field Mark typed, and a missing `coversThroughDate` there discards the
// coverage date on the error path — on a money form.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { parsePfaInput } from "@/lib/timezone";

const recordPayment = vi.hoisted(() => vi.fn());
const updatePayment = vi.hoisted(() => vi.fn());

vi.mock("./actions", () => ({ recordPayment, updatePayment }));

import {
  recordPaymentFormAction,
  updatePaymentFormAction,
  type PaymentActionResult,
} from "./form-actions";

const OK: PaymentActionResult = { ok: true };

/** The full field set the dialog submits, so a test can vary ONE key. */
function form(over: Record<string, string | null> = {}): FormData {
  const base: Record<string, string> = {
    id: "pay-1",
    coachId: "coach-a",
    amountDollars: "660.00",
    method: "zelle",
    direction: "coach_to_pfa",
    paidAtDate: "2026-08-07",
    coversThroughDate: "2026-07-31",
    // The RAW typed text `DateInput` emits beside each ISO — what lets the
    // boundary tell "left blank" from "typed something that isn't a date".
    paidAtRaw: "08/07/2026",
    coversThroughRaw: "07/31/2026",
    reference: "July 2026",
    note: "",
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...over })) {
    // `null` in the override means "OMIT this key entirely" — a different
    // thing from an empty string, and §12.1 requires both to clear.
    if (v === null) continue;
    fd.set(k, v);
  }
  return fd;
}

/** The input object that reached `updatePayment`, for the id in `form()`. */
function updatedWith(): Record<string, unknown> {
  expect(updatePayment).toHaveBeenCalledTimes(1);
  const [id, input] = updatePayment.mock.calls[0];
  expect(id).toBe("pay-1");
  return input as Record<string, unknown>;
}

beforeEach(() => {
  recordPayment.mockReset().mockResolvedValue({ coachId: "coach-a" });
  updatePayment.mockReset().mockResolvedValue({ coachId: "coach-a" });
});

/* ── §12.1 — blank must CLEAR, which means an explicit null, not an omission. */

describe("🔴 buildInput sends coversThrough as an EXPLICIT null when blank", () => {
  it("a BLANK coverage field puts `coversThrough: null` IN the object", async () => {
    // The bug: returning an object without the key. `updatePaymentSchema` is
    // `.partial()`, so an absent key is "leave unchanged" and the previously
    // set coverage date survives — Mark can set one and never remove it.
    const result = await updatePaymentFormAction(OK, form({ coversThroughDate: "", coversThroughRaw: "" }));
    expect(result).toEqual({ ok: true });

    const input = updatedWith();
    expect("coversThrough" in input).toBe(true);
    expect(input.coversThrough).toBeNull();
  });

  it("an ABSENT coverage key ALSO clears — the same explicit null", async () => {
    // Reachable for real: `DateInput` renders its hidden input only when it has
    // a `name`, and any future caller that drops the field must not silently
    // mean "leave unchanged" on a money row.
    await updatePaymentFormAction(OK, form({ coversThroughDate: null, coversThroughRaw: null }));

    const input = updatedWith();
    expect("coversThrough" in input).toBe(true);
    expect(input.coversThrough).toBeNull();
  });

  it("whitespace-only is blank too, not an invalid date", async () => {
    await updatePaymentFormAction(OK, form({ coversThroughDate: "   ", coversThroughRaw: "   " }));
    expect(updatedWith().coversThrough).toBeNull();
  });

  it("a real date becomes PFA-MIDNIGHT — the same convention as paidAt", async () => {
    // SPEC §4: two date columns on one row must store the same wall-clock
    // convention, or the month boundary that is this feature's whole failure
    // mode goes off by one.
    await updatePaymentFormAction(OK, form({ coversThroughDate: "2026-07-31" }));

    const input = updatedWith();
    expect(input.coversThrough).toEqual(parsePfaInput("2026-07-31", "00:00"));
    expect(input.paidAt).toEqual(parsePfaInput("2026-08-07", "00:00"));
  });

  it("recordPayment gets the identical shape — one buildInput, both actions", async () => {
    await recordPaymentFormAction(OK, form({ coversThroughDate: "", coversThroughRaw: "" }));
    expect(recordPayment).toHaveBeenCalledTimes(1);
    const input = recordPayment.mock.calls[0][0] as Record<string, unknown>;
    expect("coversThrough" in input).toBe(true);
    expect(input.coversThrough).toBeNull();
  });

  it("the whole object is COMPLETE on every submit", async () => {
    // The completeness is what makes `.partial()` safe: every key present on
    // every save means no field can be accidentally left unchanged.
    await updatePaymentFormAction(OK, form());
    expect(Object.keys(updatedWith()).sort()).toEqual([
      "amountCents",
      "coachId",
      "coversThrough",
      "direction",
      "method",
      "note",
      "paidAt",
      "reference",
    ]);
  });

  it("blank reference and note clear the same way", async () => {
    await updatePaymentFormAction(OK, form({ reference: "", note: "  " }));
    const input = updatedWith();
    expect(input.reference).toBeNull();
    expect(input.note).toBeNull();
  });
});

/* ── A TYPO MUST NOT SILENTLY CLEAR THE COVERAGE DATE. ───────────────────── */

describe("🔴 a non-empty but unparseable coverage entry is REJECTED, not treated as blank", () => {
  // `DateInput`'s `maskedToIso` returns "" for anything that is not a fully
  // valid calendar date — an IMPOSSIBLE one (02/31/2026) and a HALF-TYPED one
  // (07/31/202) alike. That "" used to reach `|| null` and become an explicit
  // null, which CLEARS a previously set coverage date with no validation error
  // at all. `paidAtDate` is protected by `if (!paidAtDate) throw`; coverage
  // structurally cannot be, because blank is legal — so a typo and a deliberate
  // "Not stated" were indistinguishable at the boundary, and the payment dropped
  // out of its period's statement into "no period stated". That is the precise
  // failure this whole feature exists to prevent.
  //
  // The fix carries the RAW typed text alongside the ISO in a second hidden
  // input, so the boundary can tell "empty" from "invalid".

  it("an IMPOSSIBLE date is a validation error, not a silent clear", async () => {
    const result = await updatePaymentFormAction(
      OK,
      form({ coversThroughDate: "", coversThroughRaw: "02/31/2026" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error.message).toMatch(/02\/31\/2026/);
    expect(result.error.message).toMatch(/covers through/i);
    // 🔴 The whole point: nothing was written, so nothing was cleared.
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it("a HALF-TYPED date is a validation error too", async () => {
    const result = await updatePaymentFormAction(
      OK,
      form({ coversThroughDate: "", coversThroughRaw: "07/31/202" }),
    );
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error.message).toMatch(/07\/31\/202/);
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it("a GENUINELY EMPTY field still clears — 'Not stated' is a real answer", async () => {
    // The other half, and the reason this cannot be fixed by rejecting "" alone.
    await updatePaymentFormAction(
      OK,
      form({ coversThroughDate: "", coversThroughRaw: "" }),
    );
    expect(updatedWith().coversThrough).toBeNull();
  });

  it("whitespace in the raw box is still 'empty', not a typo", async () => {
    await updatePaymentFormAction(
      OK,
      form({ coversThroughDate: "", coversThroughRaw: "   " }),
    );
    expect(updatedWith().coversThrough).toBeNull();
  });

  it("a raw box with NO hidden raw input at all still clears (older callers)", async () => {
    // Back-compat: `rawName` is opt-in on `DateInput`, so the key can be absent.
    // Absent must mean "no evidence of a typo", i.e. behave exactly as before.
    await updatePaymentFormAction(
      OK,
      form({ coversThroughDate: "", coversThroughRaw: null }),
    );
    expect(updatedWith().coversThrough).toBeNull();
  });

  it("a VALID date is unaffected by the raw text beside it", async () => {
    await updatePaymentFormAction(
      OK,
      form({ coversThroughDate: "2026-07-31", coversThroughRaw: "07/31/2026" }),
    );
    expect(updatedWith().coversThrough).toEqual(parsePfaInput("2026-07-31", "00:00"));
  });

  it("the same protection on paidAt, with its own message", async () => {
    // `paidAtDate` was never SILENT — an unparseable one hit "Pick a payment
    // date" — but that message describes an empty field, not a typo, and the two
    // date fields reading their raw text differently is how one of them drifts.
    const result = await updatePaymentFormAction(
      OK,
      form({ paidAtDate: "", paidAtRaw: "02/31/2026" }),
    );
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error.message).toMatch(/02\/31\/2026/);
    expect(result.error.message).toMatch(/payment date/i);
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it("an EMPTY paidAt still says 'pick a date' — not regressed", async () => {
    const result = await updatePaymentFormAction(
      OK,
      form({ paidAtDate: "", paidAtRaw: "" }),
    );
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error.message).toBe("Pick a payment date");
  });
});

/* ── §12.3 — the error path must re-render EVERY field Mark typed. ───────── */

describe("🔴 snapshot echoes every field back on a failed save", () => {
  it("carries coversThroughDate — a missing echo discards it silently", async () => {
    const result = await updatePaymentFormAction(
      OK,
      // A bad amount so `dollarsToCents` throws AFTER the snapshot is taken.
      form({ amountDollars: "66o.00" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.values).toEqual({
      coachId: "coach-a",
      amountDollars: "66o.00",
      method: "zelle",
      direction: "coach_to_pfa",
      paidAtDate: "2026-08-07",
      coversThroughDate: "2026-07-31",
      reference: "July 2026",
      note: "",
    });
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it("echoes a BLANK coverage date as blank, not as a re-guessed value", async () => {
    const result = await updatePaymentFormAction(
      OK,
      form({ amountDollars: "", coversThroughDate: "", coversThroughRaw: "" }),
    );
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.values.coversThroughDate).toBe("");
  });

  it("a missing payment id fails BEFORE the mutation and still echoes", async () => {
    const result = await updatePaymentFormAction(OK, form({ id: null }));
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error.message).toBe("Missing payment id");
    expect(result.values.coversThroughDate).toBe("2026-07-31");
    expect(updatePayment).not.toHaveBeenCalled();
  });

  it("recordPaymentFormAction echoes the same snapshot", async () => {
    const result = await recordPaymentFormAction(OK, form({ amountDollars: "0" }));
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error.message).toBe("Amount must be greater than zero");
    expect(result.values.coversThroughDate).toBe("2026-07-31");
    expect(recordPayment).not.toHaveBeenCalled();
  });
});

/* ── §12.2 — direction must never be coerced back to the default on an edit. */

describe("direction survives an edit", () => {
  it("a pfa_to_coach edit stays pfa_to_coach", async () => {
    // The shipped incident: `.partial()` does not strip `.default()`, so an
    // edit that omitted `direction` silently flipped a payout back to a rental.
    await updatePaymentFormAction(OK, form({ direction: "pfa_to_coach" }));
    expect(updatedWith().direction).toBe("pfa_to_coach");
  });

  it("an unknown direction is rejected, never defaulted", async () => {
    const result = await updatePaymentFormAction(OK, form({ direction: "sideways" }));
    if (result.ok) throw new Error("expected a validation failure");
    expect(result.error.message).toBe("Choose a payment direction");
  });
});
