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
import { auditLog } from "@/db/schema";
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
