// Internal rate-override mutation logic. Outside any "use server"
// file because Next.js exposes every async export from "use server"
// as a public RPC endpoint — these functions take the actor as a
// parameter, so direct exposure would let anyone forge admin
// identity.
//
// Public wrappers in src/app/admin/coaches/[id]/actions.ts gate
// these with requireRole("admin").
//
// Audit log: entityType="rate_override", entityId="${coachId}:${resourceType}"
// (composite, since the table has no surrogate id). Same safeLogAudit
// pattern as session/block actions — neon-http can't transact, so
// the audit insert is sequential and Sentry-captured on failure.

import { and, eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { coachRateOverrides } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { RateOverrideNotFoundError } from "@/lib/errors";
import {
  deleteRateOverrideSchema,
  upsertRateOverrideSchema,
} from "@/lib/schemas/rate-override";

function entityId(coachId: string, resourceType: string): string {
  return `${coachId}:${resourceType}`;
}

async function safeLogAudit(
  ...args: Parameters<typeof logAudit>
): Promise<void> {
  try {
    await logAudit(...args);
  } catch (auditErr) {
    Sentry.captureException(auditErr, {
      tags: { component: "audit", entityType: args[1].entityType },
      extra: { input: args[1] },
    });
    console.error("[audit] rate-override insert failed:", auditErr);
  }
}

export async function upsertRateOverrideInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = upsertRateOverrideSchema.parse(input);

  // Look up the existing row first so the audit can capture the
  // before-state (and so we know whether this is a create or update).
  const [existing] = await db
    .select()
    .from(coachRateOverrides)
    .where(
      and(
        eq(coachRateOverrides.coachId, parsed.coachId),
        eq(coachRateOverrides.resourceType, parsed.resourceType),
      ),
    )
    .limit(1);

  // GROUP-RATE (4th tier): three-way write for the optional group
  // weight-room override column. The schema guarantees any NON-null value
  // only appears when resourceType === "weight_room".
  //   - undefined (OMITTED) → do NOT touch the column: on insert it defaults
  //     to NULL, on update the existing group override is left intact.
  //   - null (explicit CLEAR from the rate card's blank input) → WRITE NULL,
  //     falling group bookings back to the regular weight-room rate.
  //   - a number → WRITE the number.
  // setGroupRate is true for BOTH null and a number (only undefined is
  // skipped), so the spread below writes `groupRatePer30MinCents` verbatim —
  // null clears, a number sets.
  const setGroupRate = parsed.groupRatePer30MinCents !== undefined;

  // Drizzle's onConflictDoUpdate handles the upsert atomically.
  const [row] = await db
    .insert(coachRateOverrides)
    .values({
      coachId: parsed.coachId,
      resourceType: parsed.resourceType,
      ratePer30MinCents: parsed.ratePer30MinCents,
      ...(setGroupRate && {
        groupRatePer30MinCents: parsed.groupRatePer30MinCents,
      }),
    })
    .onConflictDoUpdate({
      target: [
        coachRateOverrides.coachId,
        coachRateOverrides.resourceType,
      ],
      set: {
        ratePer30MinCents: parsed.ratePer30MinCents,
        ...(setGroupRate && {
          groupRatePer30MinCents: parsed.groupRatePer30MinCents,
        }),
      },
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "rate_override",
    entityId: entityId(parsed.coachId, parsed.resourceType),
    action: existing ? "update" : "create",
    before: existing
      ? (existing as unknown as Record<string, unknown>)
      : undefined,
    after: row as unknown as Record<string, unknown>,
  });
  return row;
}

export async function deleteRateOverrideInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = deleteRateOverrideSchema.parse(input);

  const [existing] = await db
    .select()
    .from(coachRateOverrides)
    .where(
      and(
        eq(coachRateOverrides.coachId, parsed.coachId),
        eq(coachRateOverrides.resourceType, parsed.resourceType),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new RateOverrideNotFoundError(parsed.coachId, parsed.resourceType);
  }

  await db
    .delete(coachRateOverrides)
    .where(
      and(
        eq(coachRateOverrides.coachId, parsed.coachId),
        eq(coachRateOverrides.resourceType, parsed.resourceType),
      ),
    );

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "rate_override",
    entityId: entityId(parsed.coachId, parsed.resourceType),
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}
