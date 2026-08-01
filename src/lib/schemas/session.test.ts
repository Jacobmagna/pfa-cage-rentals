// Unit tests for the coach cancel-reason schema + the pure timing resolver.
// These lock the two rules P2's UI mirrors:
//   1. reason='other' REQUIRES a non-empty (trimmed) free-text detail.
//   2. a during/after cancel REQUIRES a reason; a before-cancel ignores it.
// Pure (no DB) — the schema + resolveCancelReason carry no side effects.

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  CANCEL_REASONS,
  cancelWithReasonSchema,
  resolveCancelReason,
} from "./session";
import { CancelReasonRequiredError } from "@/lib/errors";

describe("cancelWithReasonSchema", () => {
  it("accepts every valid reason key", () => {
    for (const reason of CANCEL_REASONS) {
      const input =
        reason === "other" ? { reason, reasonOther: "detail" } : { reason };
      expect(cancelWithReasonSchema.parse(input).reason).toBe(reason);
    }
  });

  it("rejects an unknown reason key", () => {
    expect(() =>
      cancelWithReasonSchema.parse({ reason: "made_up" }),
    ).toThrow(ZodError);
  });

  it("requires reasonOther when reason is 'other'", () => {
    expect(() => cancelWithReasonSchema.parse({ reason: "other" })).toThrow(
      ZodError,
    );
    // whitespace-only is trimmed to empty → still rejected.
    expect(() =>
      cancelWithReasonSchema.parse({ reason: "other", reasonOther: "   " }),
    ).toThrow(ZodError);
  });

  it("passes when 'other' carries non-empty text (and trims it)", () => {
    const parsed = cancelWithReasonSchema.parse({
      reason: "other",
      reasonOther: "  flooded cage  ",
    });
    expect(parsed.reasonOther).toBe("flooded cage");
  });

  it("does NOT require reasonOther for non-other reasons", () => {
    expect(() =>
      cancelWithReasonSchema.parse({ reason: "no_show" }),
    ).not.toThrow();
  });

  it("allows an empty payload (no reason chosen yet)", () => {
    expect(() => cancelWithReasonSchema.parse({})).not.toThrow();
  });
});

describe("resolveCancelReason", () => {
  it("ignores the reason for a before-cancel (requiresReason=false)", () => {
    expect(
      resolveCancelReason(false, { reason: "no_show", reasonOther: "x" }),
    ).toEqual({ reason: null, reasonOther: null });
    expect(resolveCancelReason(false)).toEqual({
      reason: null,
      reasonOther: null,
    });
  });

  it("requires a reason for a during/after cancel — rejects when missing", () => {
    expect(() => resolveCancelReason(true)).toThrow(CancelReasonRequiredError);
    expect(() => resolveCancelReason(true, {})).toThrow(
      CancelReasonRequiredError,
    );
    expect(() => resolveCancelReason(true, { reason: null })).toThrow(
      CancelReasonRequiredError,
    );
  });

  it("still enforces other-requires-text on a during/after cancel", () => {
    expect(() => resolveCancelReason(true, { reason: "other" })).toThrow(
      ZodError,
    );
  });

  it("returns a resolved reason for a valid during/after cancel", () => {
    expect(resolveCancelReason(true, { reason: "athlete_cancelled" })).toEqual({
      reason: "athlete_cancelled",
      reasonOther: null,
    });
    expect(
      resolveCancelReason(true, { reason: "other", reasonOther: "flood" }),
    ).toEqual({ reason: "other", reasonOther: "flood" });
  });

  it("drops reasonOther for a non-other during/after reason", () => {
    expect(
      resolveCancelReason(true, {
        reason: "rescheduled",
        reasonOther: "ignored",
      }),
    ).toEqual({ reason: "rescheduled", reasonOther: null });
  });
});
