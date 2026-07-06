// Internal logic for editing the org-wide rate_defaults table.
// Public wrapper lives in /admin/settings/actions.ts. Same pattern
// as the other internal action files: actor passed in, audit log
// written via safeLogAudit, no Next.js or React imports.

import { eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { z } from "zod";
import { db } from "@/db";
import { rateDefaults } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import type { ResourceType } from "@/lib/billing";

// Schema mirrors the per-coach override schema: dollar input, two
// decimals max, converted to integer cents server-side.
export const updateRateDefaultsSchema = z.object({
  cageDollars: z.string().min(1, "cage rate is required"),
  bullpenDollars: z.string().min(1, "bullpen rate is required"),
  weightRoomDollars: z.string().min(1, "weight room rate is required"),
  // FACILITY-WIDE group weight-room rate (per-30-min dollar STRING, already
  // converted from per-HOUR upstream — same unit as weightRoomDollars).
  // Optional and only meaningful for the weight_room row. A non-empty value
  // SETS rate_defaults.group_rate_per_30_min_cents; an empty string CLEARS it
  // to NULL (fall back to the regular weight-room rate). Omitted entirely =
  // leave unchanged.
  weightRoomGroupDollars: z.string().optional(),
});

export type UpdateRateDefaultsInput = z.infer<typeof updateRateDefaultsSchema>;

function dollarsToCents(value: string, label: string): number {
  const trimmed = value.trim();
  // Accept "22", "22.00", "22.5", "$22", "$22.50" — strip a leading $.
  const stripped = trimmed.startsWith("$") ? trimmed.slice(1).trim() : trimmed;
  if (!/^\d+(\.\d{1,2})?$/.test(stripped)) {
    throw new Error(`${label}: enter a dollar amount like 22 or 22.50`);
  }
  const cents = Math.round(parseFloat(stripped) * 100);
  if (!Number.isFinite(cents) || cents < 0 || cents > 100_000) {
    throw new Error(`${label}: out of range`);
  }
  return cents;
}

async function safeLogAudit(
  ...args: Parameters<typeof logAudit>
): Promise<void> {
  try {
    await logAudit(...args);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: "audit", entityType: args[1].entityType },
    });
    console.error("[audit] insert failed:", err);
  }
}

const TYPES: ResourceType[] = ["cage", "bullpen", "weight_room"];

export async function updateRateDefaultsInternal(
  actor: AuthedSession["user"],
  input: unknown,
): Promise<void> {
  const parsed = updateRateDefaultsSchema.parse(input);
  const targets: Record<ResourceType, number> = {
    cage: dollarsToCents(parsed.cageDollars, "Cage"),
    bullpen: dollarsToCents(parsed.bullpenDollars, "Bullpen"),
    weight_room: dollarsToCents(parsed.weightRoomDollars, "Weight room"),
  };

  // FACILITY-WIDE group weight-room rate. Only applies to the weight_room
  // row. Tri-state:
  //   undefined  → field omitted, leave the column unchanged
  //   null       → BLANK submitted, CLEAR the column to NULL (use regular rate)
  //   number     → a value submitted, SET the column (per-30-min cents)
  // The dollar STRING is already per-30-min (converted from per-HOUR upstream,
  // same unit as weightRoomDollars), so it parses with the same helper.
  let groupTarget: number | null | undefined;
  if (parsed.weightRoomGroupDollars === undefined) {
    groupTarget = undefined;
  } else if (parsed.weightRoomGroupDollars.trim() === "") {
    groupTarget = null;
  } else {
    groupTarget = dollarsToCents(
      parsed.weightRoomGroupDollars,
      "Group weight room",
    );
  }

  const existing = await db.select().from(rateDefaults);
  const existingByType = new Map(existing.map((r) => [r.type, r]));

  for (const type of TYPES) {
    const target = targets[type];
    const current = existingByType.get(type);
    // The group rate only applies to weight_room. `undefined` → leave as-is.
    const groupForThisType =
      type === "weight_room" ? groupTarget : undefined;
    if (!current) {
      await db.insert(rateDefaults).values({
        type,
        ratePer30MinCents: target,
        // On first insert, `undefined` becomes NULL (unset) — correct default.
        groupRatePer30MinCents:
          groupForThisType === undefined ? null : groupForThisType,
      });
      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "rate_default",
        entityId: type,
        action: "create",
        after: {
          type,
          ratePer30MinCents: target,
          groupRatePer30MinCents:
            groupForThisType === undefined ? null : groupForThisType,
        },
      });
      continue;
    }
    // Did the group rate actually change? `undefined` means "not submitted",
    // so it never counts as a change.
    const groupChanged =
      groupForThisType !== undefined &&
      current.groupRatePer30MinCents !== groupForThisType;
    const rateChanged = current.ratePer30MinCents !== target;
    if (!rateChanged && !groupChanged) continue;
    await db
      .update(rateDefaults)
      .set({
        ratePer30MinCents: target,
        // Only touch the group column when it was submitted (defined).
        ...(groupForThisType !== undefined
          ? { groupRatePer30MinCents: groupForThisType }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(rateDefaults.type, type));
    await safeLogAudit(db, {
      actorUserId: actor.id,
      entityType: "rate_default",
      entityId: type,
      action: "update",
      before: {
        ratePer30MinCents: current.ratePer30MinCents,
        ...(groupChanged
          ? { groupRatePer30MinCents: current.groupRatePer30MinCents }
          : {}),
      },
      after: {
        ratePer30MinCents: target,
        ...(groupChanged ? { groupRatePer30MinCents: groupForThisType } : {}),
      },
    });
  }
}
