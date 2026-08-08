// SPEC rate-effective-dating §3/§6/§7 — THE GATE, under test.
//
// Most of these assert that something is REFUSED. That is deliberate: on a
// live payroll surface the dangerous defect is never "the button was disabled
// when it shouldn't be", it is "the button was live when it shouldn't be". So
// the negative branches get the coverage.
//
// Three properties are pinned here, and they are the three the brief asks for:
//   • the date picker never submits a future date (§3 / decision §10.1)
//   • Save is not armed until the preview has actually said something (§7)
//   • `confirmDecrease` is impossible without a deliberate second act (§6)

import { describe, expect, it } from "vitest";
import { RateRepriceDecreaseNotConfirmedError } from "@/lib/errors";
import type {
  RateRepricePreview,
  RepriceBucket,
} from "@/lib/server/rate-reprice";
import {
  decideRateEffectiveGate,
  parseConfirmDecrease,
  parseEffectiveFromInput,
  type RateEffectiveGateInput,
} from "./rate-effective-gate";
import {
  buildRepricePreviewSummary,
  DECREASE_REFUSED_MESSAGE,
} from "./rate-reprice-copy";

const READY: RateEffectiveGateInput = {
  mode: "back",
  dateValue: "2020-06-19",
  isFuture: false,
  status: "ready",
  hasDecrease: false,
  acknowledged: false,
};

const gate = (over: Partial<RateEffectiveGateInput> = {}) =>
  decideRateEffectiveGate({ ...READY, ...over });

describe("'Going forward only' — the default and the escape hatch", () => {
  it("is never blocked, whatever the preview is doing", () => {
    for (const status of ["idle", "loading", "ready", "error", "no_candidate"] as const) {
      const g = gate({ mode: "forward", status, hasDecrease: true });
      expect(g.blocked).toBe(false);
      expect(g.reason).toBe("ok");
    }
  });

  it("submits an empty value — the 'nothing already logged changes' signal", () => {
    expect(gate({ mode: "forward", dateValue: "2020-06-19" }).submittedValue).toBe(
      "",
    );
  });

  it("never sends confirmDecrease, even with a decrease acknowledged", () => {
    expect(
      gate({ mode: "forward", hasDecrease: true, acknowledged: true })
        .sendsConfirmDecrease,
    ).toBe(false);
  });
});

describe("no future dating (SPEC §3 / decision §10.1)", () => {
  it("blocks a flagged future date", () => {
    const g = gate({ isFuture: true, dateValue: "2099-01-01" });
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe("future_date");
  });

  it("refuses to SUBMIT a future date even so — it falls back to empty", () => {
    expect(gate({ isFuture: true, dateValue: "2099-01-01" }).submittedValue).toBe(
      "",
    );
  });

  it("catches a future date the caller failed to flag (typed past the picker's max)", () => {
    // isFuture deliberately left false: the control's `max` attribute is only
    // a hint, and a keyboard user can type straight through it.
    const g = gate({ isFuture: false, dateValue: "2099-01-01" });
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe("future_date");
    expect(g.submittedValue).toBe("");
  });

  it("allows a past date", () => {
    expect(gate({ dateValue: "2020-06-19" }).blocked).toBe(false);
  });
});

describe("Save is not armed until the preview speaks (SPEC §7)", () => {
  it("blocks with no date picked", () => {
    const g = gate({ dateValue: "" });
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe("no_date");
    expect(g.submittedValue).toBe("");
  });

  it.each([
    ["loading", "checking"],
    ["idle", "checking"],
    ["error", "check_failed"],
    ["no_candidate", "no_rate"],
  ] as const)("blocks while the preview is %s", (status, reason) => {
    const g = gate({ status });
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe(reason);
    expect(g.sendsConfirmDecrease).toBe(false);
  });

  it("arms once the preview is ready and nothing goes down", () => {
    const g = gate({ status: "ready" });
    expect(g.blocked).toBe(false);
    expect(g.reason).toBe("ok");
    expect(g.submittedValue).toBe("2020-06-19");
  });
});

describe("🔴 confirmDecrease is impossible without the second confirmation", () => {
  it("blocks a decrease that has not been acknowledged", () => {
    const g = gate({ hasDecrease: true, acknowledged: false });
    expect(g.blocked).toBe(true);
    expect(g.reason).toBe("decrease_unconfirmed");
    expect(g.sendsConfirmDecrease).toBe(false);
  });

  it("sends it ONLY after an explicit acknowledgement", () => {
    const g = gate({ hasDecrease: true, acknowledged: true });
    expect(g.blocked).toBe(false);
    expect(g.sendsConfirmDecrease).toBe(true);
  });

  it("never sends it when there is no decrease, acknowledged or not", () => {
    expect(gate({ hasDecrease: false, acknowledged: true }).sendsConfirmDecrease).toBe(
      false,
    );
    expect(gate({ hasDecrease: false }).sendsConfirmDecrease).toBe(false);
  });

  it("never sends it while any earlier gate is still blocking", () => {
    for (const over of [
      { status: "loading" as const },
      { status: "error" as const },
      { dateValue: "" },
      { isFuture: true },
    ]) {
      expect(
        gate({ hasDecrease: true, acknowledged: true, ...over })
          .sendsConfirmDecrease,
      ).toBe(false);
    }
  });
});

describe("parseConfirmDecrease — the only reader of the flag", () => {
  it("accepts exactly the checkbox's literal value", () => {
    expect(parseConfirmDecrease("true")).toBe(true);
  });

  it("treats an ABSENT field as no consent (an unticked box sends nothing)", () => {
    expect(parseConfirmDecrease(null)).toBe(false);
    expect(parseConfirmDecrease(undefined)).toBe(false);
  });

  it("refuses every near-miss that could be mistaken for consent", () => {
    for (const v of ["on", "1", "yes", "TRUE", "True", " true", true, 1]) {
      expect(parseConfirmDecrease(v)).toBe(false);
    }
  });
});

describe("parseEffectiveFromInput", () => {
  it("returns null for blank — 'going forward only'", () => {
    expect(parseEffectiveFromInput("")).toBeNull();
    expect(parseEffectiveFromInput("   ")).toBeNull();
  });

  it("anchors the date to PFA midnight, not UTC midnight", () => {
    // Jun 19 2026 00:00 PDT is 07:00 UTC. A naive `new Date("2026-06-19")`
    // would be 00:00 UTC — 5pm on Jun 18 in California — and would sweep an
    // extra evening of logs into the re-price window.
    expect(parseEffectiveFromInput("2026-06-19")!.toISOString()).toBe(
      "2026-06-19T07:00:00.000Z",
    );
  });

  it("handles a winter date's different offset", () => {
    // PST is UTC-8.
    expect(parseEffectiveFromInput("2026-01-15")!.toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    expect(() => parseEffectiveFromInput("6/19/2026")).toThrow(
      "Pick a valid date",
    );
    expect(() => parseEffectiveFromInput("2026-06")).toThrow("Pick a valid date");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The server-refusal path (RateRepriceDecreaseNotConfirmedError)
// ─────────────────────────────────────────────────────────────────────────

function decreasingPreview(): RateRepricePreview {
  const emptyBucket = (): RepriceBucket => ({
    logCount: 0,
    oldTotalPayCents: 0,
    newTotalPayCents: 0,
    totalDeltaCents: 0,
    logs: [],
    byCoach: [],
  });
  return {
    scope: { kind: "program_default", programId: "prog-1" },
    effectiveFrom: new Date("2026-06-19T07:00:00Z"),
    candidateRate: null,
    programId: "prog-1",
    programName: "Elite Hitting",
    scannedLogCount: 8,
    unchangedLogCount: 0,
    excludedLogCount: 4,
    changedLogCount: 8,
    payChanged: {
      logCount: 8,
      oldTotalPayCents: 200_000,
      newTotalPayCents: 122_500,
      totalDeltaCents: -77_500,
      logs: [],
      byCoach: [],
    },
    provenanceOnlyLogCount: 0,
    heldLogCount: 0,
    logs: [],
    groups: [],
    increases: emptyBucket(),
    decreases: {
      logCount: 8,
      oldTotalPayCents: 200_000,
      newTotalPayCents: 122_500,
      totalDeltaCents: -77_500,
      logs: [],
      byCoach: [
        {
          coachId: "mt",
          coachName: "Mitchell Torres",
          logCount: 5,
          oldPayCents: 120_000,
          newPayCents: 72_500,
          deltaCents: -47_500,
        },
        {
          coachId: "cp",
          coachName: "Cole Parker",
          logCount: 3,
          oldPayCents: 80_000,
          newPayCents: 50_000,
          deltaCents: -30_000,
        },
      ],
    },
    excludedCoaches: [
      {
        coachId: "am",
        coachName: "Alex Milone",
        logCount: 4,
        reason: "resolves_from_own_override",
      },
    ],
    oldTotalPayCents: 200_000,
    newTotalPayCents: 122_500,
    totalDeltaCents: -77_500,
  };
}

describe("the server refusal renders a usable screen, not a crash", () => {
  const err = new RateRepriceDecreaseNotConfirmedError(decreasingPreview());

  it("carries the SERVER-computed diff, not one the client supplied", () => {
    expect(err.code).toBe("RATE_REPRICE_DECREASE_NOT_CONFIRMED");
    expect(err.preview.decreases.byCoach).toHaveLength(2);
  });

  it("tells the admin what to do next rather than reporting a failure", () => {
    expect(DECREASE_REFUSED_MESSAGE).toBe(
      "This would lower pay on hours already logged. Review who loses what below, tick the box, then save again. " +
        "The new rate is already saved and applies to hours logged from now on — only the change to hours already logged was held.",
    );
  });

  it("says the rate itself IS already saved, so Cancel is not a rollback", () => {
    // Both save paths persist the rate BEFORE the guard can throw — the engine
    // re-resolves from persisted state, so it has to. An admin who reads only
    // "save again" and hits Cancel leaves the new rate live going forward
    // without realising it. The banner has to say so.
    expect(DECREASE_REFUSED_MESSAGE).toContain("already saved");
    expect(DECREASE_REFUSED_MESSAGE).toContain("from now on");
    expect(DECREASE_REFUSED_MESSAGE).toContain("was held");
  });

  it("re-renders the full named-coach warning from the refusal itself", () => {
    const summary = buildRepricePreviewSummary(
      err.preview,
      new Date("2026-08-07T17:00:00Z"),
    );
    expect(summary.decrease).not.toBeNull();
    expect(summary.decrease!.coachLines).toEqual([
      "Mitchell Torres −$475.00",
      "Cole Parker −$300.00",
    ]);
    expect(summary.decrease!.reassurance).toContain("will not take that money back");
  });

  it("still shows who the retro could NOT reach, on the refusal screen too", () => {
    const summary = buildRepricePreviewSummary(
      err.preview,
      new Date("2026-08-07T17:00:00Z"),
    );
    expect(summary.excludedLine).toBe(
      "Not affected: Alex Milone (they have their own rate on this program).",
    );
  });

  it("survives a preview whose log arrays came back empty over the wire", () => {
    // The refusal's preview carries per-coach rollups but no per-log rows in
    // this shape. Nothing in the copy layer may assume otherwise — a crash
    // here would white-screen a payroll page.
    expect(() =>
      buildRepricePreviewSummary(err.preview, new Date("2026-08-07T17:00:00Z")),
    ).not.toThrow();
  });

  it("re-arms the gate: the refusal means NOT acknowledged", () => {
    const g = gate({ hasDecrease: true, acknowledged: false });
    expect(g.blocked).toBe(true);
    expect(g.sendsConfirmDecrease).toBe(false);
  });
});
