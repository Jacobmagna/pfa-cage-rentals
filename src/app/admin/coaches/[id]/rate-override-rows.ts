// The rows of the coach profile's "Rate overrides" card, one per resource
// type, built from what the page loaded. Pure: no database, no React.
//
// The default each row shows (and the remove-override confirm box states)
// is the LIVE rate_defaults row for that type, the same row billing reads
// when it stamps a new rental (resolveRateCents in
// src/lib/server/session-actions.ts). Only a type with no rate_defaults row
// falls back to DEFAULT_RATES_PER_SLOT_CENTS, which holds the same numbers
// resolveRateCents falls back to (cage 2200, bullpen 2200, weight room 700
// per 30 min). Before this, the card always showed the hard-coded constant,
// so it said $14.00/hour for the weight room while billing used the live
// row.
//
// The coach's stored GROUP weight room rate is not carried: the card no
// longer shows or edits it, and no new booking is a group session.

import {
  DEFAULT_RATES_PER_SLOT_CENTS,
  type ResourceType,
} from "@/lib/billing";
import type { RateOverrideRow } from "./_components/rate-overrides-card";

export function buildRateOverrideRows(args: {
  types: readonly ResourceType[];
  /** This coach's coach_rate_overrides rows. */
  overrides: readonly {
    resourceType: ResourceType;
    ratePer30MinCents: number;
    updatedAt: Date;
  }[];
  /** The rate_defaults rows, as stored. */
  liveDefaults: readonly { type: ResourceType; ratePer30MinCents: number }[];
}): RateOverrideRow[] {
  const overrideByType = new Map(
    args.overrides.map((o) => [o.resourceType, o]),
  );
  const defaultByType = new Map(
    args.liveDefaults.map((d) => [d.type, d.ratePer30MinCents]),
  );
  return args.types.map((type) => {
    const o = overrideByType.get(type);
    return {
      resourceType: type,
      defaultCents:
        defaultByType.get(type) ?? DEFAULT_RATES_PER_SLOT_CENTS[type],
      override: o
        ? { ratePer30MinCents: o.ratePer30MinCents, updatedAt: o.updatedAt }
        : null,
    };
  });
}
