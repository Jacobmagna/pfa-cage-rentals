// Internal handles-mutation logic. Lives outside any "use server"
// file so the actor-as-parameter shape can't be exposed as an RPC
// endpoint. Public admin wrappers live in
// src/app/admin/coaches/[id]/actions.ts (user handles) and
// src/app/admin/settings/actions.ts (org settings).
//
// getOrgSettings always returns a row — the singleton 'default' row
// is seeded in migration 0013. If a deployment is missing the seed
// for any reason, the caller falls back to an in-memory default.

import { and, eq, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { orgSettings, users, type OrgSettings } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import { CoachNotFoundError } from "@/lib/errors";
import {
  updateOrgSettingsSchema,
  updateUserHandlesSchema,
} from "@/lib/schemas/handles";

const ORG_SETTINGS_ID = "default";

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
    console.error("[audit] insert failed:", auditErr);
  }
}

export async function getOrgSettings(): Promise<OrgSettings> {
  const [row] = await db
    .select()
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID))
    .limit(1);
  if (row) return row;
  // Defensive fallback — the migration seeds the row, but if a fresh
  // env skipped it, return a stub so callers don't NPE. Edit attempts
  // will re-fetch and either insert or update via the normal path.
  return {
    id: ORG_SETTINGS_ID,
    pfaVenmoHandle: null,
    pfaZelleContact: null,
    pfaDisplayName: "PFA Sports",
    updatedAt: new Date(0),
    updatedBy: null,
  };
}

export async function updateUserHandlesInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = updateUserHandlesSchema.parse(input);

  const [existing] = await db
    .select({
      id: users.id,
      venmoHandle: users.venmoHandle,
      zelleContact: users.zelleContact,
    })
    .from(users)
    .where(and(eq(users.id, parsed.userId), isNull(users.deletedAt)))
    .limit(1);
  if (!existing) throw new CoachNotFoundError(parsed.userId);

  const [updated] = await db
    .update(users)
    .set({
      ...(parsed.venmoHandle !== undefined && {
        venmoHandle: parsed.venmoHandle,
      }),
      ...(parsed.zelleContact !== undefined && {
        zelleContact: parsed.zelleContact,
      }),
    })
    .where(eq(users.id, parsed.userId))
    .returning({
      id: users.id,
      venmoHandle: users.venmoHandle,
      zelleContact: users.zelleContact,
    });

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "user_handles",
    entityId: parsed.userId,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

export async function updateOrgSettingsInternal(
  actor: AuthedSession["user"],
  input: unknown,
) {
  const parsed = updateOrgSettingsSchema.parse(input);
  const existing = await getOrgSettings();

  // Upsert pattern: if the seed row is missing, insert; otherwise update.
  // ON CONFLICT keeps both paths writing to the same row safely under
  // concurrent admin edits.
  const setValues = {
    ...(parsed.pfaVenmoHandle !== undefined && {
      pfaVenmoHandle: parsed.pfaVenmoHandle,
    }),
    ...(parsed.pfaZelleContact !== undefined && {
      pfaZelleContact: parsed.pfaZelleContact,
    }),
    ...(parsed.pfaDisplayName !== undefined && {
      pfaDisplayName: parsed.pfaDisplayName,
    }),
    updatedBy: actor.id,
  };

  const [updated] = await db
    .insert(orgSettings)
    .values({
      id: ORG_SETTINGS_ID,
      pfaVenmoHandle: parsed.pfaVenmoHandle ?? null,
      pfaZelleContact: parsed.pfaZelleContact ?? null,
      pfaDisplayName: parsed.pfaDisplayName ?? "PFA Sports",
      updatedBy: actor.id,
    })
    .onConflictDoUpdate({
      target: orgSettings.id,
      set: setValues,
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "org_settings",
    entityId: ORG_SETTINGS_ID,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}
