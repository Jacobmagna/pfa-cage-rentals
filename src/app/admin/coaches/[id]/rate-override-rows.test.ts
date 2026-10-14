// Unit tests for the coach profile's "Rate overrides" rows (pure module).
// The default a row shows must be the price billing uses: the live
// rate_defaults row, and the hard-coded constant only when a type has no row.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RATES_PER_SLOT_CENTS,
  type ResourceType,
} from "@/lib/billing";
import { buildRateOverrideRows } from "./rate-override-rows";

const TYPES: ResourceType[] = ["cage", "bullpen", "weight_room"];
const UPDATED = new Date("2026-10-01T17:00:00Z");

describe("buildRateOverrideRows", () => {
  it("a type with a live default row shows the live rate, not the constant", () => {
    const rows = buildRateOverrideRows({
      types: TYPES,
      overrides: [],
      // Production today: weight room $10.00/hour = 500 per 30 min.
      liveDefaults: [
        { type: "cage", ratePer30MinCents: 2200 },
        { type: "bullpen", ratePer30MinCents: 2200 },
        { type: "weight_room", ratePer30MinCents: 500 },
      ],
    });
    const wr = rows.find((r) => r.resourceType === "weight_room");
    expect(wr?.defaultCents).toBe(500);
    expect(DEFAULT_RATES_PER_SLOT_CENTS.weight_room).toBe(700);
  });

  it("a type with NO default row falls back to the constant billing falls back to", () => {
    const rows = buildRateOverrideRows({
      types: TYPES,
      overrides: [],
      liveDefaults: [{ type: "cage", ratePer30MinCents: 2500 }],
    });
    expect(rows.map((r) => [r.resourceType, r.defaultCents])).toEqual([
      ["cage", 2500],
      ["bullpen", 2200],
      ["weight_room", 700],
    ]);
  });

  it("one row per type, in the order given, with this coach's override merged in", () => {
    const rows = buildRateOverrideRows({
      types: TYPES,
      overrides: [
        { resourceType: "weight_room", ratePer30MinCents: 350, updatedAt: UPDATED },
      ],
      liveDefaults: [{ type: "weight_room", ratePer30MinCents: 500 }],
    });
    expect(rows).toEqual([
      { resourceType: "cage", defaultCents: 2200, override: null },
      { resourceType: "bullpen", defaultCents: 2200, override: null },
      {
        resourceType: "weight_room",
        defaultCents: 500,
        override: { ratePer30MinCents: 350, updatedAt: UPDATED },
      },
    ]);
  });

  it("carries no group rate, even when one is stored: the card no longer shows or edits it", () => {
    // As the page loads it: the stored row still has its group column.
    const stored = {
      resourceType: "weight_room" as const,
      ratePer30MinCents: 350,
      updatedAt: UPDATED,
      groupRatePer30MinCents: 1600,
    };
    const rows = buildRateOverrideRows({
      types: TYPES,
      overrides: [stored],
      liveDefaults: [],
    });
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "defaultCents",
        "override",
        "resourceType",
      ]);
    }
  });
});
