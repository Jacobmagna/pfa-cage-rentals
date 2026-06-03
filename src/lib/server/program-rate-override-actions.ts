// Internal per-coach PROGRAM rate-override mutation logic. Mirrors
// src/lib/server/rate-override-actions.ts exactly, but keyed on
// (coachId, programId) instead of (coachId, resourceType).
//
// Outside any "use server" file because Next.js exposes every async
// export from a "use server" file as a public RPC endpoint — these
// functions take the actor as a parameter, so direct exposure would let
// anyone forge admin identity. Public wrappers in
// src/app/admin/coaches/[id]/actions.ts gate these with
// requireRole("admin").
//
// Audit log: entityType="program_rate_override",
// entityId="${coachId}:${programId}" (composite, since the table has no
// surrogate id). Same safeLogAudit pattern as the resource-type override
// actions — neon-http can't transact, so the audit insert is sequential
// and Sentry-captured on failure.

import { and, eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { programRateOverrides } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { ProgramRateOverrideNotFoundError } from "@/lib/errors";
import {
  deleteProgramRateOverrideSchema,
  upsertProgramRateOverrideSchema,
} from "@/lib/schemas/rate-override";

function entityId(coachId: string, programId: string): string {
  return `${coachId}:${programId}`;
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
    console.error("[audit] program-rate-override insert failed:", auditErr);
  }
}

export async function upsertProgramRateOverrideInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = upsertProgramRateOverrideSchema.parse(input);

  // Look up the existing row first so the audit can capture the
  // before-state (and so we know whether this is a create or update).
  const [existing] = await db
    .select()
    .from(programRateOverrides)
    .where(
      and(
        eq(programRateOverrides.coachId, parsed.coachId),
        eq(programRateOverrides.programId, parsed.programId),
      ),
    )
    .limit(1);

  // Drizzle's onConflictDoUpdate handles the upsert atomically.
  const [row] = await db
    .insert(programRateOverrides)
    .values({
      coachId: parsed.coachId,
      programId: parsed.programId,
      ratePer30MinCents: parsed.ratePer30MinCents,
    })
    .onConflictDoUpdate({
      target: [
        programRateOverrides.coachId,
        programRateOverrides.programId,
      ],
      set: { ratePer30MinCents: parsed.ratePer30MinCents },
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program_rate_override",
    entityId: entityId(parsed.coachId, parsed.programId),
    action: existing ? "update" : "create",
    before: existing
      ? (existing as unknown as Record<string, unknown>)
      : undefined,
    after: row as unknown as Record<string, unknown>,
  });
  return row;
}

export async function deleteProgramRateOverrideInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = deleteProgramRateOverrideSchema.parse(input);

  const [existing] = await db
    .select()
    .from(programRateOverrides)
    .where(
      and(
        eq(programRateOverrides.coachId, parsed.coachId),
        eq(programRateOverrides.programId, parsed.programId),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new ProgramRateOverrideNotFoundError(
      parsed.coachId,
      parsed.programId,
    );
  }

  await db
    .delete(programRateOverrides)
    .where(
      and(
        eq(programRateOverrides.coachId, parsed.coachId),
        eq(programRateOverrides.programId, parsed.programId),
      ),
    );

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "program_rate_override",
    entityId: entityId(parsed.coachId, parsed.programId),
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}
