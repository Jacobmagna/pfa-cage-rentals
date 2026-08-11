// payment-statement SPEC §6 — the month chips are PRESETS OVER THE from/to,
// not a second period model.
//
// The property that matters is the last describe block: a chip's `{from, to}`
// pushed back through the REAL filter parser must land on exactly the instants
// `pfaMonthRange` produces. If that ever drifts, tapping "Jul" and typing
// 2026-07-01 → 2026-07-31 would produce two different statements from the same
// intent, and only one of them would be right.
//
// ⚠️ Every assertion here is TZ-independent by construction (`pfaParts` /
// `pfaMonthRange` are PFA-pinned), which is why this file is safe under the
// `TZ=Asia/Tokyo` and `TZ=America/New_York` runs SPEC §12.6 requires.

import { describe, expect, it } from "vitest";
import { normalizeFilters } from "@/lib/reports/filters";
import { pfaMonthRange, parsePfaInput } from "@/lib/timezone";
import { statementPeriodPresets } from "./period";

/** Noon PFA, so the instant is unambiguous in any runtime TZ. */
function noon(date: string): Date {
  return parsePfaInput(date, "12:00");
}

describe("statementPeriodPresets — the current PFA month and the two prior", () => {
  it("returns three chips, oldest first", () => {
    const presets = statementPeriodPresets(noon("2026-08-11"));
    expect(presets.map((p) => p.label)).toEqual(["Jun", "Jul", "Aug"]);
  });

  it("spans each whole PFA calendar month", () => {
    const presets = statementPeriodPresets(noon("2026-08-11"));
    expect(presets).toEqual([
      { label: "Jun", from: "2026-06-01", to: "2026-06-30" },
      { label: "Jul", from: "2026-07-01", to: "2026-07-31" },
      { label: "Aug", from: "2026-08-01", to: "2026-08-31" },
    ]);
  });

  it("ends the current chip on the month's last day, not today", () => {
    // A statement period is a MONTH. A chip that stopped at "today" would make
    // the same chip mean a different range every morning.
    const presets = statementPeriodPresets(noon("2026-08-01"));
    expect(presets[2]).toEqual({
      label: "Aug",
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });

  it("handles February in a leap year", () => {
    const presets = statementPeriodPresets(noon("2028-02-10"));
    expect(presets[2]).toEqual({
      label: "Feb",
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
});

describe("statementPeriodPresets — the year boundary", () => {
  // The reason there are chips at all rather than 12 month tabs: no year
  // selector, and nothing that breaks in January.
  it("reaches back into the previous year in January", () => {
    const presets = statementPeriodPresets(noon("2026-01-15"));
    expect(presets).toEqual([
      { label: "Nov 2025", from: "2025-11-01", to: "2025-11-30" },
      { label: "Dec 2025", from: "2025-12-01", to: "2025-12-31" },
      { label: "Jan", from: "2026-01-01", to: "2026-01-31" },
    ]);
  });

  it("names the year only when it is not the current one", () => {
    const presets = statementPeriodPresets(noon("2026-02-15"));
    expect(presets.map((p) => p.label)).toEqual(["Dec 2025", "Jan", "Feb"]);
  });

  it("crosses December cleanly", () => {
    const presets = statementPeriodPresets(noon("2025-12-31"));
    expect(presets.map((p) => p.from)).toEqual([
      "2025-10-01",
      "2025-11-01",
      "2025-12-01",
    ]);
  });
});

describe("🔴 a chip is a PRESET over the from/to — one code path", () => {
  it.each(["2026-08-11", "2026-01-15", "2026-03-01", "2028-02-29"])(
    "every chip generated at %s resolves through normalizeFilters to its pfaMonthRange",
    (today) => {
      for (const preset of statementPeriodPresets(noon(today))) {
        const filters = normalizeFilters({
          from: preset.from,
          to: preset.to,
        });
        const range = pfaMonthRange(preset.from);
        // The exact two instants the engine buckets by. Half-open, so the
        // period's last day is `toDateExclusive − 1ms` — the boundary Alex
        // Milone's real case lands on.
        expect(filters.fromDate.getTime()).toBe(range.startUtc.getTime());
        expect(filters.toDateExclusive.getTime()).toBe(range.endUtc.getTime());
      }
    },
  );
});
