// Integration tests for the internal program mutation logic
// (src/lib/server/program-actions.ts). These hit a real Neon dev
// branch — see vitest.integration.config.ts and tests/integration/
// setup.ts for env wiring.
//
// We call the INTERNAL functions directly with a synthetic admin actor
// instead of going through the public "use server" wrappers in
// src/app/admin/programs/actions.ts. The wrappers add a single line —
// requireRole("admin") — covered separately via mocked auth(); calling
// internals here lets the test run without mocking framework internals.
//
// truncateMutables() does NOT touch `programs`, so every test creates
// its own program(s) with a unique name suffix and scopes assertions to
// the created program/row ids. audit_log IS truncated between tests.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, programs } from "@/db/schema";
import {
  createProgramInternal,
  deactivateProgramInternal,
  updateProgramInternal,
} from "@/lib/server/program-actions";
import { ProgramNameTakenError, ProgramNotFoundError } from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

// program-actions → @/lib/authz → @/auth → next-auth, which fails to
// resolve in the vitest node environment. We never exercise real auth()
// here (synthetic actor), so stubbing @/auth is purely to break that
// import chain.
vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

let fixtures: FixtureUsers;

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function programName(): string {
  return `Programs Test ${uniqueSuffix()}`;
}

describe("createProgramInternal", () => {
  it("creates a program and writes a program/create audit row", async () => {
    const name = programName();
    const created = await createProgramInternal(fixtures.admin, { name });

    expect(created.id).toBeTruthy();
    expect(created.name).toBe(name);
    expect(created.active).toBe(true);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "create")),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].entityType).toBe("program");
    expect(auditRows[0].actorUserId).toBe(fixtures.admin.id);
  });

  it("rejects a duplicate name with ProgramNameTakenError", async () => {
    const name = programName();
    await createProgramInternal(fixtures.admin, { name });
    await expect(
      createProgramInternal(fixtures.admin, { name }),
    ).rejects.toBeInstanceOf(ProgramNameTakenError);
  });
});

describe("updateProgramInternal", () => {
  it("renames a program and audits a changed-keys-only before/after diff", async () => {
    const created = await createProgramInternal(fixtures.admin, {
      name: programName(),
    });
    const newName = programName();

    const updated = await updateProgramInternal(fixtures.admin, created.id, {
      name: newName,
    });
    expect(updated.name).toBe(newName);

    const updateRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "update")),
      );
    expect(updateRows).toHaveLength(1);
    expect(updateRows[0].entityType).toBe("program");
    const diff = updateRows[0].diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.name).toBe(created.name);
    expect(diff.after.name).toBe(newName);
    // active didn't change → must not appear in the diff.
    expect(diff.before).not.toHaveProperty("active");
  });

  it("throws ProgramNotFoundError for a missing id", async () => {
    await expect(
      updateProgramInternal(fixtures.admin, "does-not-exist", {
        name: programName(),
      }),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
  });

  it("rejects a rename to a name already taken (ProgramNameTakenError)", async () => {
    const a = await createProgramInternal(fixtures.admin, {
      name: programName(),
    });
    const b = await createProgramInternal(fixtures.admin, {
      name: programName(),
    });
    await expect(
      updateProgramInternal(fixtures.admin, b.id, { name: a.name }),
    ).rejects.toBeInstanceOf(ProgramNameTakenError);
  });
});

describe("deactivateProgramInternal", () => {
  it("sets active=false + audits, then reactivates via updateProgramInternal", async () => {
    const created = await createProgramInternal(fixtures.admin, {
      name: programName(),
    });
    expect(created.active).toBe(true);

    const deactivated = await deactivateProgramInternal(
      fixtures.admin,
      created.id,
    );
    expect(deactivated.active).toBe(false);

    const updateRows = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.entityId, created.id), eq(auditLog.action, "update")),
      );
    expect(updateRows).toHaveLength(1);
    const diff = updateRows[0].diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.active).toBe(true);
    expect(diff.after.active).toBe(false);

    const reactivated = await updateProgramInternal(
      fixtures.admin,
      created.id,
      { active: true },
    );
    expect(reactivated.active).toBe(true);
  });

  it("throws ProgramNotFoundError for a missing id", async () => {
    await expect(
      deactivateProgramInternal(fixtures.admin, "does-not-exist"),
    ).rejects.toBeInstanceOf(ProgramNotFoundError);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 🔴 STIPEND SPEC §2.13 — programs.stipend_eligible, Mark's per-PROGRAM
// switch. These functions are the ONLY write path to that column in the
// product; before it existed the column had three readers and no writers, so
// the entire stipend feature shipped inert (an admin could set a coach's
// amount and no log would ever be covered).
//
// Coverage requires BOTH facts — an eligible program AND a coach with an
// amount — so the money-level proof that this switch actually reaches pay
// lives in stipend-earnings.test.ts, where the coach and the trigger exist.
// What is asserted here is the write path itself, in both directions.
// ─────────────────────────────────────────────────────────────────────────

/** Read the column straight from the row, not from the action's return. */
async function storedEligibility(id: string): Promise<boolean> {
  const [row] = await db
    .select({ stipendEligible: programs.stipendEligible })
    .from(programs)
    .where(eq(programs.id, id))
    .limit(1);
  return row.stipendEligible;
}

describe("🔴 stipend eligibility — the write path", () => {
  it("defaults a new program to NOT eligible when the caller says nothing", async () => {
    const created = await createProgramInternal(fixtures.admin, {
      name: programName(),
    });
    expect(created.stipendEligible).toBe(false);
    expect(await storedEligibility(created.id)).toBe(false);
  });

  it("creates an eligible program when asked — and its control does not", async () => {
    // Paired on the same call shape: a test asserting "this is true" proves
    // nothing against a fixture that is true for another reason.
    const eligible = await createProgramInternal(fixtures.admin, {
      name: programName(),
      stipendEligible: true,
    });
    const control = await createProgramInternal(fixtures.admin, {
      name: programName(),
      stipendEligible: false,
    });

    expect(await storedEligibility(eligible.id)).toBe(true);
    expect(await storedEligibility(control.id)).toBe(false);
  });

  it("turns eligibility ON and audits the before/after", async () => {
    const created = await createProgramInternal(fixtures.admin, {
      name: programName(),
    });

    const updated = await updateProgramInternal(fixtures.admin, created.id, {
      stipendEligible: true,
    });
    expect(updated.stipendEligible).toBe(true);
    expect(await storedEligibility(created.id)).toBe(true);

    const diff = await singleUpdateDiff(created.id);
    expect(diff.before.stipendEligible).toBe(false);
    expect(diff.after.stipendEligible).toBe(true);
    // Nothing else moved — the audit trail has to name this and only this,
    // or a reader cannot tell a payroll switch from a rename.
    expect(diff.before).not.toHaveProperty("name");
  });

  it("turns eligibility OFF again", async () => {
    const created = await createProgramInternal(fixtures.admin, {
      name: programName(),
      stipendEligible: true,
    });

    const updated = await updateProgramInternal(fixtures.admin, created.id, {
      stipendEligible: false,
    });
    expect(updated.stipendEligible).toBe(false);
    expect(await storedEligibility(created.id)).toBe(false);
  });

  it("🔴 a partial update that never mentions it leaves it ALONE", async () => {
    // This is the reactivateProgramAction path — `{ active: true }` and
    // nothing else. If absence were read as `false`, reactivating a program
    // would silently stop a stipend covering its work, and every log on it
    // would start paying hourly ON TOP of the coach's stipend. Nothing would
    // report it: the save succeeds and the audit diff looks deliberate.
    const created = await createProgramInternal(fixtures.admin, {
      name: programName(),
      stipendEligible: true,
    });

    await deactivateProgramInternal(fixtures.admin, created.id);
    expect(await storedEligibility(created.id)).toBe(true);

    const reactivated = await updateProgramInternal(fixtures.admin, created.id, {
      active: true,
    });
    expect(reactivated.active).toBe(true);
    expect(reactivated.stipendEligible).toBe(true);
    expect(await storedEligibility(created.id)).toBe(true);
  });

  it("🔴 a RENAME leaves it alone too", async () => {
    // The same hazard reached by the other partial-update caller. Paired with
    // an ineligible control so a bug that pins the column to one value cannot
    // pass both halves.
    const eligible = await createProgramInternal(fixtures.admin, {
      name: programName(),
      stipendEligible: true,
    });
    const control = await createProgramInternal(fixtures.admin, {
      name: programName(),
      stipendEligible: false,
    });

    await updateProgramInternal(fixtures.admin, eligible.id, {
      name: programName(),
    });
    await updateProgramInternal(fixtures.admin, control.id, {
      name: programName(),
    });

    expect(await storedEligibility(eligible.id)).toBe(true);
    expect(await storedEligibility(control.id)).toBe(false);
  });

  it("does not appear in the audit diff when it did not change", async () => {
    const created = await createProgramInternal(fixtures.admin, {
      name: programName(),
      stipendEligible: true,
    });

    await updateProgramInternal(fixtures.admin, created.id, {
      name: programName(),
      // Explicitly re-stated at its existing value — a full-form save, which
      // is what the edit dialog sends every time.
      stipendEligible: true,
    });

    const diff = await singleUpdateDiff(created.id);
    expect(diff.after).not.toHaveProperty("stipendEligible");
    expect(diff.after.name).toBeTruthy();
  });
});

/** The one program/update audit row's changed-keys-only diff. */
async function singleUpdateDiff(programId: string): Promise<{
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.entityId, programId), eq(auditLog.action, "update")));
  expect(rows).toHaveLength(1);
  expect(rows[0].entityType).toBe("program");
  return rows[0].diff as {
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
}
