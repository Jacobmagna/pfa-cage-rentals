// Internal payment-mutation logic. Same pattern as
// src/lib/server/session-actions.ts — lives outside any "use server"
// file because these helpers take the actor as a parameter, so
// exposing them as RPC endpoints would let any caller forge an
// admin identity.
//
// All four entry points (create / update / delete / confirm) are
// wrapped by the public actions in src/app/admin/payments/actions.ts
// behind requireRole("admin").
//
// Status semantics:
//   - create: admin-recorded payments auto-confirm
//     (recordedBy === confirmedBy at creation time, status = "confirmed").
//     Coach-self-reported payments (P4 surface, not yet built) will
//     pass `status: "pending"` instead.
//   - confirm: pending → confirmed, sets confirmedBy + confirmedAt.
//     No-op (throws PaymentAlreadyConfirmedError) if already confirmed.
//   - update: edits to amount/method/reference/note/paidAt. Status
//     transitions go through `confirm` only (separate mutation kept
//     auditable distinctly).
//   - delete: soft-delete via deletedAt, keeps the audit trail.

import { and, eq, isNull } from "drizzle-orm";
import * as Sentry from "@sentry/nextjs";
import { db } from "@/db";
import { coachPayments, users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import type { AuthedSession } from "@/lib/authz";
import {
  CoachNotFoundError,
  PaymentAlreadyConfirmedError,
  PaymentNotFoundError,
} from "@/lib/errors";
import {
  createPaymentSchema,
  updatePaymentSchema,
} from "@/lib/schemas/payment";

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

async function getActiveCoachOrThrow(coachId: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, coachId), isNull(users.deletedAt)))
    .limit(1);
  if (!row) throw new CoachNotFoundError(coachId);
  return row;
}

async function getActivePaymentOrThrow(id: string) {
  const [row] = await db
    .select()
    .from(coachPayments)
    .where(and(eq(coachPayments.id, id), isNull(coachPayments.deletedAt)))
    .limit(1);
  if (!row) throw new PaymentNotFoundError(id);
  return row;
}

export async function createPaymentInternal(
  actor: AuthedSession["user"],
  input: unknown,
  options?: { status?: "pending" | "confirmed" },
) {
  const parsed = createPaymentSchema.parse(input);
  await getActiveCoachOrThrow(parsed.coachId);

  // Admin-recorded entries auto-confirm. The options seam keeps the
  // door open for the future coach-self-report flow (P4) without
  // duplicating the validate + audit chain.
  const status = options?.status ?? "confirmed";
  const now = new Date();

  const [inserted] = await db
    .insert(coachPayments)
    .values({
      coachId: parsed.coachId,
      amountCents: parsed.amountCents,
      method: parsed.method,
      direction: parsed.direction,
      paidAt: parsed.paidAt,
      reference: parsed.reference ?? null,
      note: parsed.note ?? null,
      status,
      recordedBy: actor.id,
      confirmedBy: status === "confirmed" ? actor.id : null,
      confirmedAt: status === "confirmed" ? now : null,
    })
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "payment",
    entityId: inserted.id,
    action: "create",
    after: inserted as unknown as Record<string, unknown>,
  });
  return inserted;
}

export async function updatePaymentInternal(
  actor: AuthedSession["user"],
  id: string,
  input: unknown,
) {
  const parsed = updatePaymentSchema.parse(input);
  const existing = await getActivePaymentOrThrow(id);

  if (parsed.coachId !== undefined) {
    await getActiveCoachOrThrow(parsed.coachId);
  }

  const [updated] = await db
    .update(coachPayments)
    .set({
      ...(parsed.coachId !== undefined && { coachId: parsed.coachId }),
      ...(parsed.amountCents !== undefined && {
        amountCents: parsed.amountCents,
      }),
      ...(parsed.method !== undefined && { method: parsed.method }),
      ...(parsed.direction !== undefined && { direction: parsed.direction }),
      ...(parsed.paidAt !== undefined && { paidAt: parsed.paidAt }),
      ...(parsed.reference !== undefined && { reference: parsed.reference }),
      ...(parsed.note !== undefined && { note: parsed.note }),
    })
    .where(eq(coachPayments.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "payment",
    entityId: id,
    action: "update",
    before: existing as unknown as Record<string, unknown>,
    after: updated as unknown as Record<string, unknown>,
  });
  return updated;
}

export async function deletePaymentInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const existing = await getActivePaymentOrThrow(id);

  const now = new Date();
  await db
    .update(coachPayments)
    .set({ deletedAt: now })
    .where(eq(coachPayments.id, id));

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "payment",
    entityId: id,
    action: "delete",
    before: existing as unknown as Record<string, unknown>,
  });
}

export async function confirmPaymentInternal(
  actor: AuthedSession["user"],
  id: string,
) {
  const existing = await getActivePaymentOrThrow(id);
  if (existing.status === "confirmed") {
    throw new PaymentAlreadyConfirmedError(id);
  }

  const now = new Date();
  const [updated] = await db
    .update(coachPayments)
    .set({ status: "confirmed", confirmedBy: actor.id, confirmedAt: now })
    .where(eq(coachPayments.id, id))
    .returning();

  await safeLogAudit(db, {
    actorUserId: actor.id,
    entityType: "payment",
    entityId: id,
    action: "update",
    before: { status: existing.status, confirmedBy: existing.confirmedBy },
    after: {
      status: updated.status,
      confirmedBy: updated.confirmedBy,
      confirmedAt: updated.confirmedAt,
    },
  });
  return updated;
}
