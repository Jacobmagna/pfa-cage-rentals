// QA2 #6 — internal work-pay-mode mutation logic. Lives outside any
// "use server" file so the actor-as-parameter shape can't be exposed as
// a public RPC endpoint. Public admin wrapper lives in
// src/app/admin/coaches/[id]/actions.ts (gated with requireRole).
//
// One row per coach (coachId PK). Upsert via onConflictDoUpdate so a
// coach with no settings row yet (today's implicit "hourly") gets one
// created on first save. When payMode = "hourly" we keep whatever
// perSessionRateCents was previously stored (don't null it out) so a
// coach who flips per-session → hourly → per-session doesn't lose their
// amount; "hourly" simply ignores the value.
//
// This only sets how FUTURE logged work is paid — the billing layer
// snapshots the basis onto each log at write time, so already-logged
// work is unaffected (the pay computation itself is owned by another
// worker).
//
// Audit log: entityType="coach_pay_settings", entityId=coachId.

import { eq } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { coachPaySettings } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { updateCoachPaySettingsSchema } from "@/lib/schemas/coach-pay-settings";

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
    console.error("[audit] coach-pay-settings insert failed:", auditErr);
  }
}

export async function updateCoachPaySettingsInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = updateCoachPaySettingsSchema.parse(input);

  // Read the existing row first so the audit captures the before-state
  // and so "hourly" can preserve a previously-stored per-session amount.
  const [existing] = await db
    .select()
    .from(coachPaySettings)
    .where(eq(coachPaySettings.coachId, parsed.coachId))
    .limit(1);

  // per_session → use the (required, validated) amount.
  // hourly → keep the prior amount if any (NULL on first insert).
  const nextRateCents =
    parsed.payMode === "per_session"
      ? (parsed.perSessionRateCents ?? null)
      : (existing?.perSessionRateCents ?? null);

  const [row] = await db
    .insert(coachPaySettings)
    .values({
      coachId: parsed.coachId,
      payMode: parsed.payMode,
      perSessionRateCents: nextRateCents,
    })
    .onConflictDoUpdate({
      target: coachPaySettings.coachId,
      set: {
        payMode: parsed.payMode,
        perSessionRateCents: nextRateCents,
      },
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "coach_pay_settings",
    entityId: parsed.coachId,
    action: existing ? "update" : "create",
    before: existing
      ? (existing as unknown as Record<string, unknown>)
      : undefined,
    after: row as unknown as Record<string, unknown>,
  });
  return row;
}
