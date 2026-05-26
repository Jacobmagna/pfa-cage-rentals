// Integration tests for src/lib/server/payment-actions.ts. Hits the
// real Neon dev branch. Same direct-internal pattern as
// session-actions.test.ts — we call the *Internal exports directly
// with a synthetic admin actor; the public "use server" wrappers in
// src/app/admin/payments/actions.ts add only requireRole("admin")
// (covered generically in admin-actions-authz.test.ts) and
// revalidatePath (no observable side-effect in node test).
//
// Cleanup: coach_payments is now in truncateMutables (fixtures.ts).
// Each test starts with a fresh table.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, coachPayments, users } from "@/db/schema";
import {
  confirmPaymentInternal,
  createPaymentInternal,
  deletePaymentInternal,
  updatePaymentInternal,
} from "@/lib/server/payment-actions";
import {
  CoachNotFoundError,
  PaymentAlreadyConfirmedError,
  PaymentNotFoundError,
} from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

let fixtures: FixtureUsers;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

function uniqueEmail(label: string): string {
  return `pay-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
}

async function createThrowawayCoach(name = "Pay Test Coach") {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail("coach"), name, role: "coach" })
    .returning();
  return row;
}

function paidAt(daysAgo = 1): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(12, 0, 0, 0);
  return d;
}

function baseCreateInput(coachId: string) {
  return {
    coachId,
    amountCents: 5000,
    method: "venmo" as const,
    paidAt: paidAt(1),
    reference: "ref-abc",
    note: "test payment",
  };
}

describe("createPaymentInternal", () => {
  it("inserts a row and auto-confirms admin-recorded payments", async () => {
    const coach = await createThrowawayCoach();
    const before = new Date();
    const inserted = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );
    const after = new Date();

    expect(inserted.id).toBeTruthy();
    expect(inserted.coachId).toBe(coach.id);
    expect(inserted.amountCents).toBe(5000);
    expect(inserted.method).toBe("venmo");
    expect(inserted.reference).toBe("ref-abc");
    expect(inserted.note).toBe("test payment");
    expect(inserted.status).toBe("confirmed");
    expect(inserted.recordedBy).toBe(fixtures.admin.id);
    expect(inserted.confirmedBy).toBe(fixtures.admin.id);
    expect(inserted.confirmedAt).toBeInstanceOf(Date);
    expect(inserted.confirmedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(inserted.confirmedAt!.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(inserted.deletedAt).toBeNull();

    const [row] = await db
      .select()
      .from(coachPayments)
      .where(eq(coachPayments.id, inserted.id));
    expect(row).toBeDefined();
    expect(row.amountCents).toBe(5000);
  });

  it("writes a matching audit row with the full inserted snapshot", async () => {
    const coach = await createThrowawayCoach();
    const inserted = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "payment"),
          eq(auditLog.entityId, inserted.id),
          eq(auditLog.action, "create"),
        ),
      );
    expect(audit).toBeDefined();
    expect(audit.actorUserId).toBe(fixtures.admin.id);
    const diff = audit.diff as { after: Record<string, unknown> };
    expect(diff.after.amountCents).toBe(5000);
    expect(diff.after.coachId).toBe(coach.id);
    expect(diff.after.status).toBe("confirmed");
  });

  it("creates a pending payment when options.status='pending' is passed", async () => {
    const coach = await createThrowawayCoach();
    const inserted = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
      { status: "pending" },
    );
    expect(inserted.status).toBe("pending");
    expect(inserted.confirmedBy).toBeNull();
    expect(inserted.confirmedAt).toBeNull();
  });

  it("rejects payments for a non-existent coach", async () => {
    await expect(
      createPaymentInternal(fixtures.admin, {
        ...baseCreateInput("00000000-0000-0000-0000-000000000000"),
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("rejects payments for a soft-deleted coach", async () => {
    const coach = await createThrowawayCoach();
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, coach.id));

    await expect(
      createPaymentInternal(fixtures.admin, baseCreateInput(coach.id)),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("rejects zero, negative, and non-integer amountCents", async () => {
    const coach = await createThrowawayCoach();

    await expect(
      createPaymentInternal(fixtures.admin, {
        ...baseCreateInput(coach.id),
        amountCents: 0,
      }),
    ).rejects.toThrow();

    await expect(
      createPaymentInternal(fixtures.admin, {
        ...baseCreateInput(coach.id),
        amountCents: -100,
      }),
    ).rejects.toThrow();

    await expect(
      createPaymentInternal(fixtures.admin, {
        ...baseCreateInput(coach.id),
        amountCents: 50.5,
      }),
    ).rejects.toThrow();
  });

  it("rejects unsupported payment methods", async () => {
    const coach = await createThrowawayCoach();
    await expect(
      createPaymentInternal(fixtures.admin, {
        ...baseCreateInput(coach.id),
        method: "bitcoin",
      }),
    ).rejects.toThrow();
  });

  it("rejects missing coachId via schema", async () => {
    await expect(
      createPaymentInternal(fixtures.admin, {
        amountCents: 1000,
        method: "cash",
        paidAt: paidAt(1),
      }),
    ).rejects.toThrow();
  });
});

describe("updatePaymentInternal", () => {
  it("updates amountCents and writes a changed-keys-only audit diff", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );

    const updated = await updatePaymentInternal(fixtures.admin, created.id, {
      amountCents: 7500,
    });
    expect(updated.amountCents).toBe(7500);
    expect(updated.method).toBe("venmo");
    expect(updated.note).toBe("test payment");

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "payment"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.amountCents).toBe(5000);
    expect(diff.after.amountCents).toBe(7500);
    expect(diff.before.method).toBeUndefined();
    expect(diff.after.method).toBeUndefined();
  });

  it("updates multiple fields and only changed keys land in the diff", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );

    await updatePaymentInternal(fixtures.admin, created.id, {
      method: "zelle",
      note: "updated note",
    });

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "payment"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "update"),
        ),
      );
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.method).toBe("venmo");
    expect(diff.after.method).toBe("zelle");
    expect(diff.before.note).toBe("test payment");
    expect(diff.after.note).toBe("updated note");
    expect("amountCents" in diff.before).toBe(false);
  });

  it("re-points to a different coach when coachId is supplied", async () => {
    const a = await createThrowawayCoach("Coach A");
    const b = await createThrowawayCoach("Coach B");
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(a.id),
    );
    const updated = await updatePaymentInternal(fixtures.admin, created.id, {
      coachId: b.id,
    });
    expect(updated.coachId).toBe(b.id);
  });

  it("rejects re-pointing to a non-existent coach", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );
    await expect(
      updatePaymentInternal(fixtures.admin, created.id, {
        coachId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });

  it("rejects updates against a non-existent payment id", async () => {
    await expect(
      updatePaymentInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
        { amountCents: 1000 },
      ),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it("rejects updates against a soft-deleted payment", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );
    await deletePaymentInternal(fixtures.admin, created.id);
    await expect(
      updatePaymentInternal(fixtures.admin, created.id, { amountCents: 9999 }),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });
});

describe("deletePaymentInternal", () => {
  it("soft-deletes and writes an audit row with the pre-state snapshot", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );

    await deletePaymentInternal(fixtures.admin, created.id);

    const [row] = await db
      .select()
      .from(coachPayments)
      .where(eq(coachPayments.id, created.id));
    expect(row).toBeDefined();
    expect(row.deletedAt).toBeInstanceOf(Date);

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "payment"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "delete"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as { before: Record<string, unknown> };
    expect(diff.before.amountCents).toBe(5000);
    expect(diff.before.coachId).toBe(coach.id);
  });

  it("rejects deleting a non-existent payment", async () => {
    await expect(
      deletePaymentInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it("rejects deleting an already-soft-deleted payment", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );
    await deletePaymentInternal(fixtures.admin, created.id);
    await expect(
      deletePaymentInternal(fixtures.admin, created.id),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });
});

describe("confirmPaymentInternal", () => {
  it("transitions pending → confirmed and records the confirmer", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
      { status: "pending" },
    );
    expect(created.status).toBe("pending");

    const before = new Date();
    const confirmed = await confirmPaymentInternal(fixtures.admin, created.id);
    const after = new Date();

    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.confirmedBy).toBe(fixtures.admin.id);
    expect(confirmed.confirmedAt).toBeInstanceOf(Date);
    expect(confirmed.confirmedAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(confirmed.confirmedAt!.getTime()).toBeLessThanOrEqual(
      after.getTime(),
    );

    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "payment"),
          eq(auditLog.entityId, created.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audit).toBeDefined();
    const diff = audit.diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.status).toBe("pending");
    expect(diff.after.status).toBe("confirmed");
  });

  it("refuses to confirm a payment that is already confirmed", async () => {
    const coach = await createThrowawayCoach();
    const created = await createPaymentInternal(
      fixtures.admin,
      baseCreateInput(coach.id),
    );
    // Admin create auto-confirms; second confirm should reject.
    await expect(
      confirmPaymentInternal(fixtures.admin, created.id),
    ).rejects.toBeInstanceOf(PaymentAlreadyConfirmedError);
  });

  it("rejects confirming a non-existent payment", async () => {
    await expect(
      confirmPaymentInternal(
        fixtures.admin,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });
});
