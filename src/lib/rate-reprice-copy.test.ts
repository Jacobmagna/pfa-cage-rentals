// SPEC rate-effective-dating §6/§7 — the WORDS Mark reads, under test.
//
// These are not cosmetic assertions. The preview line, the excluded-coaches
// line and the decrease warning are the three safety controls between an
// admin and a retroactive payroll rewrite, and the owner they are written for
// has already lost months of payroll to a rate model he misread. A wording
// regression here is a money regression.
//
// Every case pins an INJECTED `now`, so none of it is hostage to the calendar.

import { describe, expect, it } from "vitest";
import type {
  RateRepricePreview,
  RepriceBucket,
  RepriceLogDiff,
} from "@/lib/server/rate-reprice";
import {
  buildDecreaseWarning,
  buildExcludedLine,
  buildHeldLine,
  buildProvenanceLine,
  buildRepriceAppliedMessage,
  buildRepricePreviewSummary,
  describeEffectiveMode,
  formatMoneyCents,
  formatNameList,
  formatRateLabel,
  formatRepriceRange,
  formatShortDate,
  formatSignedMoneyCents,
  isFutureEffectiveDate,
  maxEffectiveDate,
  pluralEntries,
} from "./rate-reprice-copy";

// "Now" for every test: 2026-08-07, mid-morning PFA time.
const NOW = new Date("2026-08-07T17:00:00Z");

// ─────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────

function log(
  over: Partial<RepriceLogDiff> & { coachName: string; deltaCents: number },
): RepriceLogDiff {
  const oldPay = over.oldPayCents ?? 10_000;
  return {
    logId: over.logId ?? `log-${Math.random().toString(36).slice(2)}`,
    coachId: over.coachId ?? over.coachName.toLowerCase().replace(/\s+/g, "-"),
    coachName: over.coachName,
    programId: over.programId ?? "prog-1",
    startAt: over.startAt ?? new Date("2026-06-19T17:00:00Z"),
    endAt: over.endAt ?? new Date("2026-06-19T19:00:00Z"),
    oldRatePer30MinCents: 2_000,
    newRatePer30MinCents: 3_000,
    oldPerSessionRateCents: null,
    newPerSessionRateCents: null,
    oldRateSourceKind: "program_default",
    newRateSourceKind: "program_default",
    oldPayCents: oldPay,
    newPayCents: oldPay + over.deltaCents,
    deltaCents: over.deltaCents,
  };
}

function bucket(logs: RepriceLogDiff[]): RepriceBucket {
  const byCoachMap = new Map<
    string,
    { coachId: string; coachName: string; logCount: number; oldPayCents: number; newPayCents: number; deltaCents: number }
  >();
  let oldTotalPayCents = 0;
  let newTotalPayCents = 0;
  for (const l of logs) {
    oldTotalPayCents += l.oldPayCents;
    newTotalPayCents += l.newPayCents;
    const e = byCoachMap.get(l.coachId) ?? {
      coachId: l.coachId,
      coachName: l.coachName,
      logCount: 0,
      oldPayCents: 0,
      newPayCents: 0,
      deltaCents: 0,
    };
    e.logCount += 1;
    e.oldPayCents += l.oldPayCents;
    e.newPayCents += l.newPayCents;
    e.deltaCents += l.deltaCents;
    byCoachMap.set(l.coachId, e);
  }
  return {
    logCount: logs.length,
    oldTotalPayCents,
    newTotalPayCents,
    totalDeltaCents: newTotalPayCents - oldTotalPayCents,
    logs,
    // Mirrors the engine's ordering: biggest absolute move first.
    byCoach: [...byCoachMap.values()].sort(
      (a, b) =>
        Math.abs(b.deltaCents) - Math.abs(a.deltaCents) ||
        a.coachName.localeCompare(b.coachName),
    ),
  };
}

function preview(over: Partial<RateRepricePreview> = {}): RateRepricePreview {
  const logs = over.logs ?? [];
  const increases = logs.filter((l) => l.deltaCents > 0);
  const decreases = logs.filter((l) => l.deltaCents < 0);
  const oldTotalPayCents = logs.reduce((a, l) => a + l.oldPayCents, 0);
  const newTotalPayCents = logs.reduce((a, l) => a + l.newPayCents, 0);
  return {
    scope: { kind: "program_default", programId: "prog-1" },
    effectiveFrom: new Date("2026-06-19T07:00:00Z"),
    candidateRate: null,
    programId: "prog-1",
    programName: "Elite Hitting",
    scannedLogCount: logs.length,
    unchangedLogCount: 0,
    excludedLogCount: 0,
    changedLogCount: logs.length,
    // The headline set: rows whose PAY moves. Defaults to exactly that subset,
    // mirroring computeRateRepriceDiff.
    payChanged: bucket(logs.filter((l) => l.deltaCents !== 0)),
    provenanceOnlyLogCount: 0,
    heldLogCount: 0,
    logs,
    groups: [],
    increases: bucket(increases),
    decreases: bucket(decreases),
    excludedCoaches: [],
    oldTotalPayCents,
    newTotalPayCents,
    totalDeltaCents: newTotalPayCents - oldTotalPayCents,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe("money formatting", () => {
  it("never abbreviates and always shows two decimals", () => {
    expect(formatMoneyCents(124_000)).toBe("$1,240.00");
    expect(formatMoneyCents(0)).toBe("$0.00");
    expect(formatMoneyCents(5)).toBe("$0.05");
  });

  it("uses a real minus sign, not a hyphen, for negatives", () => {
    expect(formatMoneyCents(-47_500)).toBe("−$475.00");
  });

  it("signs deltas so an increase is unmistakable", () => {
    expect(formatSignedMoneyCents(44_000)).toBe("+$440.00");
    expect(formatSignedMoneyCents(-47_500)).toBe("−$475.00");
    expect(formatSignedMoneyCents(0)).toBe("$0.00");
  });
});

describe("pluralEntries", () => {
  it("says entry for one and entries otherwise", () => {
    expect(pluralEntries(1)).toBe("1 entry");
    expect(pluralEntries(0)).toBe("0 entries");
    expect(pluralEntries(14)).toBe("14 entries");
  });
});

describe("rate labels", () => {
  it("doubles hourly cents (stored per 30 min, shown per hour)", () => {
    expect(
      formatRateLabel({
        payMode: "hourly",
        ratePer30MinCents: 1_500,
        perSessionRateCents: null,
      }),
    ).toBe("$30.00 / hr");
  });

  it("shows a per-session amount FLAT — never doubled (bug class 0052)", () => {
    expect(
      formatRateLabel({
        payMode: "per_session",
        ratePer30MinCents: null,
        perSessionRateCents: 10_000,
      }),
    ).toBe("$100.00 / session");
  });

  it("says so plainly when no rate is set", () => {
    expect(
      formatRateLabel({
        payMode: "hourly",
        ratePer30MinCents: null,
        perSessionRateCents: null,
      }),
    ).toBe("No rate set");
    expect(
      formatRateLabel({
        payMode: "per_session",
        ratePer30MinCents: null,
        perSessionRateCents: null,
      }),
    ).toBe("No per-session amount set");
  });
});

describe("date range", () => {
  it("formats in PFA time without the year when it is the current one", () => {
    expect(formatShortDate(new Date("2026-06-19T17:00:00Z"), NOW)).toBe("Jun 19");
  });

  it("adds the year once the date leaves the current one", () => {
    expect(formatShortDate(new Date("2025-12-30T18:00:00Z"), NOW)).toBe(
      "Dec 30, 2025",
    );
  });

  it("spans first to last affected entry", () => {
    const p = preview({
      logs: [
        log({ coachName: "Alex Milone", deltaCents: 100, startAt: new Date("2026-08-07T17:00:00Z") }),
        log({ coachName: "Cole Parker", deltaCents: 100, startAt: new Date("2026-06-19T17:00:00Z") }),
      ],
    });
    expect(formatRepriceRange(p, NOW)).toBe("Jun 19 – Aug 7");
  });

  it("collapses to a single date when everything lands on one day", () => {
    const p = preview({
      logs: [log({ coachName: "Alex Milone", deltaCents: 100 })],
    });
    expect(formatRepriceRange(p, NOW)).toBe("Jun 19");
  });

  it("is null when nothing would change", () => {
    expect(formatRepriceRange(preview(), NOW)).toBeNull();
  });
});

describe("the date cap — no future dating (SPEC §3 / §10.1)", () => {
  it("caps the picker at today in PFA time", () => {
    expect(maxEffectiveDate(NOW)).toBe("2026-08-07");
  });

  it("uses PFA time, not UTC, for the boundary", () => {
    // 2026-08-08T05:00Z is still Aug 7, 10pm, in California.
    expect(maxEffectiveDate(new Date("2026-08-08T05:00:00Z"))).toBe("2026-08-07");
  });

  it("rejects tomorrow and accepts today and any past date", () => {
    expect(isFutureEffectiveDate("2026-08-08", NOW)).toBe(true);
    expect(isFutureEffectiveDate("2026-08-07", NOW)).toBe(false);
    expect(isFutureEffectiveDate("2026-06-19", NOW)).toBe(false);
    expect(isFutureEffectiveDate("2027-01-01", NOW)).toBe(true);
  });

  it("treats an incomplete value as not-yet-future rather than an error", () => {
    expect(isFutureEffectiveDate("", NOW)).toBe(false);
    expect(isFutureEffectiveDate("2026-08", NOW)).toBe(false);
  });
});

describe("the mode helper text", () => {
  it("spells out that the default touches nothing already logged", () => {
    expect(describeEffectiveMode("forward", "", NOW)).toBe(
      "The new rate applies to hours logged from now on. Nothing already logged changes.",
    );
  });

  it("prompts for a date before one is picked", () => {
    expect(describeEffectiveMode("back", "", NOW)).toContain(
      "Pick the date this rate should have started",
    );
  });

  it("names the date once picked", () => {
    expect(describeEffectiveMode("back", "2026-06-19", NOW)).toBe(
      "Hours already logged from Jun 19 forward will be re-priced at this rate.",
    );
  });

  it("refuses a future date in words", () => {
    expect(describeEffectiveMode("back", "2026-08-08", NOW)).toBe(
      "Pick today or a date in the past — a rate can't start in the future.",
    );
  });
});

describe("the preview summary (SPEC §6)", () => {
  it("quotes count, range and both dollar totals", () => {
    const p = preview({
      logs: [
        log({ coachName: "Alex Milone", deltaCents: 22_000, oldPayCents: 62_000, startAt: new Date("2026-06-19T17:00:00Z") }),
        log({ coachName: "Cole Parker", deltaCents: 22_000, oldPayCents: 62_000, startAt: new Date("2026-08-07T17:00:00Z") }),
      ],
      changedLogCount: 14,
      payChanged: {
        logCount: 14,
        oldTotalPayCents: 124_000,
        newTotalPayCents: 168_000,
        totalDeltaCents: 44_000,
        logs: [
          log({ coachName: "Alex Milone", deltaCents: 22_000, oldPayCents: 62_000, startAt: new Date("2026-06-19T17:00:00Z") }),
          log({ coachName: "Cole Parker", deltaCents: 22_000, oldPayCents: 62_000, startAt: new Date("2026-08-07T17:00:00Z") }),
        ],
        byCoach: [],
      },
    });
    const s = buildRepricePreviewSummary(p, NOW);
    expect(s.hasChanges).toBe(true);
    expect(s.headline).toBe(
      "Re-pricing 14 entries from Jun 19 – Aug 7. Pay $1,240.00 → $1,680.00 (+$440.00).",
    );
    // The sentence is the parts, joined — nothing added, nothing lost.
    expect(s.headlineParts.map((x) => x.text).join("")).toBe(s.headline);
    // …and the run carrying the signed delta must never break across lines.
    expect(s.headlineParts.filter((x) => x.nowrap).map((x) => x.text)).toEqual([
      "(+$440.00).",
    ]);
    expect(s.direction).toBe("increase");
  });

  it("uses the singular for a single entry", () => {
    const p = preview({
      logs: [log({ coachName: "Alex Milone", deltaCents: 1_000, oldPayCents: 4_000 })],
    });
    expect(buildRepricePreviewSummary(p, NOW).headline).toBe(
      "Re-pricing 1 entry from Jun 19. Pay $40.00 → $50.00 (+$10.00).",
    );
  });

  it("says nothing exists back there when the window is empty", () => {
    const s = buildRepricePreviewSummary(
      preview({ scannedLogCount: 0, changedLogCount: 0, logs: [] }),
      NOW,
    );
    expect(s.hasChanges).toBe(false);
    expect(s.headline).toBe(
      "Nothing to re-price. No logged entries on or after Jun 19.",
    );
    expect(s.decrease).toBeNull();
  });

  it("distinguishes 'already pays this' from 'nothing is there'", () => {
    const s = buildRepricePreviewSummary(
      preview({ scannedLogCount: 6, unchangedLogCount: 6, changedLogCount: 0, logs: [] }),
      NOW,
    );
    expect(s.hasChanges).toBe(false);
    expect(s.headline).toBe(
      "No change. All 6 entries from Jun 19 onward already pay this rate.",
    );
  });

  it("carries the excluded-coaches line even when nothing changes", () => {
    const s = buildRepricePreviewSummary(
      preview({
        scannedLogCount: 0,
        changedLogCount: 0,
        logs: [],
        excludedLogCount: 5,
        excludedCoaches: [
          { coachId: "a", coachName: "Alex Milone", logCount: 3, reason: "resolves_from_own_override" },
        ],
      }),
      NOW,
    );
    expect(s.excludedLine).toBe(
      "Not affected: Alex Milone (they have their own rate on this program).",
    );
  });
});

describe("the excluded-coaches line (SPEC §5/§6 — what it will NOT touch)", () => {
  const excluded = (...names: string[]) =>
    preview({
      excludedCoaches: names.map((coachName, i) => ({
        coachId: `c${i}`,
        coachName,
        logCount: 2,
        reason: "resolves_from_own_override" as const,
      })),
    });

  it("is null when nobody is excluded", () => {
    expect(buildExcludedLine(preview())).toBeNull();
  });

  it("names one coach", () => {
    expect(buildExcludedLine(excluded("Alex Milone"))).toBe(
      "Not affected: Alex Milone (they have their own rate on this program).",
    );
  });

  it("names two coaches", () => {
    expect(buildExcludedLine(excluded("Alex Milone", "Cole Parker"))).toBe(
      "Not affected: Alex Milone and Cole Parker (they have their own rate on this program).",
    );
  });

  it("names three or more coaches, all of them", () => {
    expect(
      buildExcludedLine(excluded("Alex Milone", "Cole Parker", "Mitchell Torres")),
    ).toBe(
      "Not affected: Alex Milone, Cole Parker and Mitchell Torres (they have their own rate on this program).",
    );
  });

  it("formats name lists without swallowing anyone", () => {
    expect(formatNameList([])).toBe("");
    expect(formatNameList(["A"])).toBe("A");
    expect(formatNameList(["A", "B"])).toBe("A and B");
    expect(formatNameList(["A", "B", "C", "D"])).toBe("A, B, C and D");
  });
});

describe("🔴 the decrease warning (SPEC §6 — hard stop)", () => {
  const decreasing = preview({
    logs: [
      log({ coachName: "Mitchell Torres", coachId: "mt", deltaCents: -47_500, oldPayCents: 100_000 }),
      log({ coachName: "Cole Parker", coachId: "cp", deltaCents: -30_000, oldPayCents: 60_000 }),
      log({ coachName: "Alex Milone", coachId: "am", deltaCents: 5_000, oldPayCents: 20_000 }),
    ],
  });

  it("is null when nothing goes down — Save stays a single click", () => {
    const p = preview({
      logs: [log({ coachName: "Alex Milone", deltaCents: 5_000 })],
    });
    expect(buildDecreaseWarning(p)).toBeNull();
    expect(buildRepricePreviewSummary(p, NOW).decrease).toBeNull();
  });

  it("fires on ANY decrease, even when the net total goes UP", () => {
    const p = preview({
      logs: [
        log({ coachName: "Mitchell Torres", coachId: "mt", deltaCents: -1_000 }),
        log({ coachName: "Alex Milone", coachId: "am", deltaCents: 90_000 }),
      ],
    });
    expect(p.totalDeltaCents).toBeGreaterThan(0);
    expect(buildDecreaseWarning(p)).not.toBeNull();
  });

  it("states the direction in words, not just a red minus", () => {
    expect(buildDecreaseWarning(decreasing)!.headline).toBe(
      "This lowers pay on hours already logged.",
    );
  });

  it("names each coach and what THEY lose, biggest first", () => {
    expect(buildDecreaseWarning(decreasing)!.coachLines).toEqual([
      "Mitchell Torres −$475.00",
      "Cole Parker −$300.00",
    ]);
  });

  it("never lists a coach who is only going UP", () => {
    expect(buildDecreaseWarning(decreasing)!.coachLines.join(" ")).not.toContain(
      "Alex Milone",
    );
  });

  it("says plainly that this does NOT claw money back (no payout ledger)", () => {
    expect(buildDecreaseWarning(decreasing)!.reassurance).toBe(
      "If they have already been paid, this will not take that money back — it only changes what the app says they are owed.",
    );
  });

  it("labels the second confirmation as a deliberate act", () => {
    expect(buildDecreaseWarning(decreasing)!.acknowledgeLabel).toBe(
      "I understand this lowers already-logged pay. Apply it anyway.",
    );
  });

  it("totals the decrease bucket only", () => {
    expect(buildDecreaseWarning(decreasing)!.totalDeltaCents).toBe(-77_500);
  });
});

describe("the applied message", () => {
  it("reports what actually moved", () => {
    const p = preview({
      logs: [log({ coachName: "Alex Milone", deltaCents: 22_000, oldPayCents: 62_000 })],
    });
    expect(buildRepriceAppliedMessage(p, NOW)).toBe(
      "Rate saved and 1 entry re-priced (Jun 19). Pay $620.00 → $840.00 (+$220.00).",
    );
  });

  it("is honest when the rate saved but nothing needed re-pricing", () => {
    expect(buildRepriceAppliedMessage(preview({ changedLogCount: 0 }), NOW)).toBe(
      "Rate saved. Nothing already logged needed re-pricing.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 🔴 THE FIRST PRODUCTION RUN (provenance-only rows)
// ─────────────────────────────────────────────────────────────────────────
//
// `rate_source_kind` shipped nullable with no backfill, so on prod every
// pre-existing hour_logs row has a NULL provenance and lands in `changed` with
// deltaCents = 0. The headline must count what MOVES MONEY, or the very first
// run tells Mark it is re-pricing 214 entries when 6 do anything.

describe("provenance-only rows never reach the headline", () => {
  /** 214 rows written, 6 of them moving money. */
  function firstProdRun(): RateRepricePreview {
    const moving = [
      log({ coachName: "Alex Milone", deltaCents: 22_000, oldPayCents: 62_000, startAt: new Date("2026-06-19T17:00:00Z") }),
      log({ coachName: "Cole Parker", deltaCents: 22_000, oldPayCents: 62_000, startAt: new Date("2026-08-07T17:00:00Z") }),
    ];
    const payChanged = { ...bucket(moving), logCount: 6 };
    return preview({
      scannedLogCount: 214,
      changedLogCount: 214,
      provenanceOnlyLogCount: 208,
      payChanged,
      logs: moving,
      // The engine's whole-set totals are unchanged by any of this.
      oldTotalPayCents: 124_000,
      newTotalPayCents: 168_000,
      totalDeltaCents: 44_000,
    });
  }

  it("counts the entries that move money, not the rows that get an UPDATE", () => {
    const s = buildRepricePreviewSummary(firstProdRun(), NOW);
    expect(s.headline).toBe(
      "Re-pricing 6 entries from Jun 19 – Aug 7. Pay $1,240.00 → $1,680.00 (+$440.00).",
    );
    expect(s.headline).not.toContain("214");
  });

  it("states the provenance rows separately, and says no pay changed", () => {
    const s = buildRepricePreviewSummary(firstProdRun(), NOW);
    expect(s.provenanceLine).toBe(
      "208 more entries get a record-keeping fix (noting where their rates came from). No pay change.",
    );
  });

  it("🔒 the dollar delta is untouched", () => {
    const s = buildRepricePreviewSummary(firstProdRun(), NOW);
    expect(s.headline).toContain("(+$440.00).");
  });

  it("reaches the 'already pay this rate' branch on a FIRST run", () => {
    // This branch was unreachable: with every row landing in `changed`,
    // changedLogCount was never 0.
    const s = buildRepricePreviewSummary(
      preview({
        scannedLogCount: 214,
        changedLogCount: 214,
        provenanceOnlyLogCount: 214,
        payChanged: bucket([]),
        logs: [],
        oldTotalPayCents: 0,
        newTotalPayCents: 0,
        totalDeltaCents: 0,
      }),
      NOW,
    );
    expect(s.hasChanges).toBe(false);
    expect(s.headline).toBe(
      "No change. All 214 entries from Jun 19 onward already pay this rate.",
    );
    expect(s.provenanceLine).toBe(
      "214 more entries get a record-keeping fix (noting where their rates came from). No pay change.",
    );
  });

  it("says nothing about provenance when there is none", () => {
    expect(buildProvenanceLine(0)).toBeNull();
    expect(buildRepricePreviewSummary(preview({}), NOW).provenanceLine).toBeNull();
  });

  it("uses the singular for one row", () => {
    expect(buildProvenanceLine(1)).toBe(
      "1 more entry gets a record-keeping fix (noting where its rate came from). No pay change.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// HELD ENTRIES (SPEC §6) — informational, never a dollar
// ─────────────────────────────────────────────────────────────────────────

describe("the held-entries line", () => {
  it("appears only when something is held", () => {
    expect(buildHeldLine(0)).toBeNull();
    expect(buildHeldLine(-1)).toBeNull();
    expect(buildRepricePreviewSummary(preview({}), NOW).heldLine).toBeNull();
  });

  it("names the count and says to re-run after approving", () => {
    const s = buildRepricePreviewSummary(preview({ heldLogCount: 2 }), NOW);
    expect(s.heldLine).toBe(
      "2 entries in this range are held and weren't re-priced (they're awaiting approval). Re-run this after approving them.",
    );
  });

  it("reads correctly for a single held entry", () => {
    expect(buildHeldLine(1)).toBe(
      "1 entry in this range is held and wasn't re-priced (it's awaiting approval). Re-run this after approving it.",
    );
  });

  it("never touches the headline or its money", () => {
    const withHeld = preview({
      logs: [log({ coachName: "Alex Milone", deltaCents: 1_000, oldPayCents: 4_000 })],
      heldLogCount: 3,
    });
    const without = preview({
      logs: [log({ coachName: "Alex Milone", deltaCents: 1_000, oldPayCents: 4_000 })],
    });
    expect(buildRepricePreviewSummary(withHeld, NOW).headline).toBe(
      buildRepricePreviewSummary(without, NOW).headline,
    );
  });

  it("rides along on the applied message too", () => {
    expect(
      buildRepriceAppliedMessage(preview({ changedLogCount: 0, heldLogCount: 2 }), NOW),
    ).toBe(
      "Rate saved. Nothing already logged needed re-pricing. " +
        "2 entries in this range are held and weren't re-priced (they're awaiting approval). Re-run this after approving them.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DIRECTION + THE UNBREAKABLE DELTA
// ─────────────────────────────────────────────────────────────────────────

describe("the headline carries its direction", () => {
  it("marks a raise as an increase", () => {
    const s = buildRepricePreviewSummary(
      preview({ logs: [log({ coachName: "Alex Milone", deltaCents: 1_000, oldPayCents: 4_000 })] }),
      NOW,
    );
    expect(s.direction).toBe("increase");
  });

  it("marks a cut as a decrease", () => {
    const s = buildRepricePreviewSummary(
      preview({ logs: [log({ coachName: "Alex Milone", deltaCents: -12_000, oldPayCents: 24_000 })] }),
      NOW,
    );
    expect(s.direction).toBe("decrease");
  });

  it("holds the signed delta on one line, sign attached to its amount", () => {
    const s = buildRepricePreviewSummary(
      preview({ logs: [log({ coachName: "Alex Milone", deltaCents: -12_000, oldPayCents: 24_000 })] }),
      NOW,
    );
    const nowrap = s.headlineParts.filter((p) => p.nowrap);
    expect(nowrap).toHaveLength(1);
    // The U+2212 minus and the amount are in ONE unbreakable run.
    expect(nowrap[0].text).toBe("(\u2212$120.00).");
    expect(s.headlineParts.map((p) => p.text).join("")).toBe(s.headline);
  });

  it("has no direction when nothing changes", () => {
    expect(
      buildRepricePreviewSummary(preview({ scannedLogCount: 0, changedLogCount: 0, logs: [] }), NOW)
        .direction,
    ).toBe("none");
  });
});
