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

  const existing = await db.select().from(rateDefaults);
  const existingByType = new Map(existing.map((r) => [r.type, r]));

  for (const type of TYPES) {
    const target = targets[type];
    const current = existingByType.get(type);
    if (!current) {
      await db.insert(rateDefaults).values({
        type,
        ratePer30MinCents: target,
      });
      await safeLogAudit(db, {
        actorUserId: actor.id,
        entityType: "rate_default",
        entityId: type,
        action: "create",
        after: { type, ratePer30MinCents: target },
      });
      continue;
    }
    if (current.ratePer30MinCents === target) continue;
    await db
      .update(rateDefaults)
      .set({ ratePer30MinCents: target, updatedAt: new Date() })
      .where(eq(rateDefaults.type, type));
    await safeLogAudit(db, {
      actorUserId: actor.id,
      entityType: "rate_default",
      entityId: type,
      action: "update",
      before: { ratePer30MinCents: current.ratePer30MinCents },
      after: { ratePer30MinCents: target },
    });
  }
}
