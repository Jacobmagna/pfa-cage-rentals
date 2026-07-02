// QA-2 SECURITY BAR: no write path succeeds against an ARCHIVED coach.
//
// The coach-detail page (/admin/coaches/[id]) now RENDERS archived
// (deletedAt non-null) coaches in read-only mode instead of 404'ing. That
// makes every mutating server action on that page REACHABLE for an archived
// target — UI-hiding the editors is not enough, because a forged direct RPC
// call could still target an archived coach. actions.ts guards every mutation
// with assertCoachNotArchived(), which throws a typed CoachArchivedError. This
// suite proves that guard fires on ALL 8 mutating actions, and that restore —
// the ONE mutation allowed on an archived coach — succeeds and re-opens writes.
//
// Auth-mock pattern copied EXACTLY from schedule-admin-grant-authz.test.ts:
// vi.mock("@/auth") with a hoisted authMock fn the scenario resolves, plus
// vi.mock("next/cache") to no-op revalidatePath (which throws outside a Next
// request context and would mask the success path).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { coachRateOverrides, programRateOverrides, users } from "@/db/schema";
import { CoachArchivedError } from "@/lib/errors";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

// Public wrappers call revalidatePath() after a successful mutation. Outside a
// Next.js request context that throws "static generation store missing",
// masking the success path (the restore positive-control below). Stub to no-op.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

let fixtures: FixtureUsers;

// A dedicated throwaway coach seeded fresh per test so archiving one test's
// coach can never leak into another. Cleaned up in afterAll.
const throwawayCoachIds: string[] = [];

function uniqueEmail(label: string): string {
  return `archived-guard-${label}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@test.invalid`;
}

async function createCoach(name = "Archived Guard Coach") {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail("coach"), name, role: "coach" })
    .returning();
  throwawayCoachIds.push(row.id);
  return row;
}

// Archive a coach the same way archiveCoachInternal does: set deletedAt to a
// date, PRESERVING name/email/role.
async function archiveCoach(coachId: string) {
  await db
    .update(users)
    .set({ deletedAt: new Date() })
    .where(eq(users.id, coachId));
}

async function readDeletedAt(coachId: string): Promise<Date | null> {
  const [row] = await db
    .select({ deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, coachId))
    .limit(1);
  return row?.deletedAt ?? null;
}

function mockAsAdmin() {
  authMock.mockResolvedValue({
    user: {
      id: fixtures.admin.id,
      email: fixtures.admin.email,
      role: "admin",
    },
  });
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
  authMock.mockReset();
  mockAsAdmin();
});

afterAll(async () => {
  // Remove every throwaway coach we seeded (and, via CASCADE-safe explicit
  // deletes, their override rows). truncateMutables already clears
  // coach_rate_overrides between tests, but do the child deletes defensively
  // in case the last test left rows.
  for (const id of throwawayCoachIds) {
    await db.delete(coachRateOverrides).where(eq(coachRateOverrides.coachId, id));
    await db
      .delete(programRateOverrides)
      .where(eq(programRateOverrides.coachId, id));
  }
  for (const id of throwawayCoachIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("archived-coach write guard (QA-2 defense in depth)", () => {
  it("upsertRateOverride is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { upsertRateOverride } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    await expect(
      upsertRateOverride({
        coachId: coach.id,
        resourceType: "cage",
        ratePer30MinCents: 1700,
      }),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("deleteRateOverride is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { deleteRateOverride } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    await expect(
      deleteRateOverride(coach.id, "cage"),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("upsertProgramRateOverride is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { upsertProgramRateOverride } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    // The guard fires on coachId BEFORE the internal validates programId, so a
    // placeholder programId is fine — we assert the archived rejection, not a
    // program-not-found error.
    await expect(
      upsertProgramRateOverride({
        coachId: coach.id,
        programId: "00000000-0000-0000-0000-000000000000",
        payMode: "hourly",
        ratePer30MinCents: 1700,
      }),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("deleteProgramRateOverride is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { deleteProgramRateOverride } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    await expect(
      deleteProgramRateOverride(
        coach.id,
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("updateCoachHandles (keys on userId) is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { updateCoachHandles } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    // Handles payloads target the coach via `userId` (not `coachId`).
    await expect(
      updateCoachHandles({
        userId: coach.id,
        venmoHandle: "somehandle",
        zelleContact: "coach@example.com",
      }),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("updateCoachNotes is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { updateCoachNotes } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    await expect(
      updateCoachNotes({ coachId: coach.id, notes: "should be blocked" }),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("setCoachScheduleAdmin is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { setCoachScheduleAdmin } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    await expect(
      setCoachScheduleAdmin({ coachId: coach.id, enabled: true }),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("updateCoachPaySettings is rejected with CoachArchivedError", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    const { updateCoachPaySettings } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    await expect(
      updateCoachPaySettings({ coachId: coach.id, payMode: "hourly" }),
    ).rejects.toBeInstanceOf(CoachArchivedError);
  });

  it("positive control: restoreCoach SUCCEEDS on an archived coach, and writes re-open afterward", async () => {
    const coach = await createCoach();
    await archiveCoach(coach.id);
    expect(await readDeletedAt(coach.id)).not.toBeNull();

    // Restore is the ONE mutation allowed on an archived coach — it's NOT
    // guarded. It lives on the /admin/coaches list actions module.
    const { restoreCoach } = await import("@/app/admin/coaches/actions");
    await restoreCoach(coach.id);

    // deletedAt is cleared → coach is active again.
    expect(await readDeletedAt(coach.id)).toBeNull();

    // A representative guarded write now SUCCEEDS (the guard no longer fires
    // because the coach is no longer archived).
    const { updateCoachNotes } = await import(
      "@/app/admin/coaches/[id]/actions"
    );
    const result = await updateCoachNotes({
      coachId: coach.id,
      notes: "editable again",
    });
    expect(result.id).toBe(coach.id);

    const [persisted] = await db
      .select({ notes: users.notes })
      .from(users)
      .where(eq(users.id, coach.id))
      .limit(1);
    expect(persisted.notes).toBe("editable again");
  });
});
