// Integration tests: the GROUP weight room rate inputs are gone from Settings
// ("Default rental rates") and from the coach profile ("Rate overrides").
// What does a save WITHOUT the group field do to a group rate already stored?
//
//   - Settings, "Save defaults": the facility group default becomes NULL.
//   - Coach profile, weight room "Save": the coach's group override becomes
//     NULL; the regular weight room override is saved as typed.
//
// Both go through the REAL form actions with a FormData built exactly as the
// cards now build it (no group field), as an admin. Each clearing test is
// paired with a control: the same action, given a group field, still sets it,
// so the clear comes from the field being absent and nothing else.
//
// rate_defaults is NOT truncated between tests: this file snapshots every
// row (both rate columns) in beforeAll and restores it after each test.
// coach_rate_overrides is truncated by truncateMutables.
//
// `@/auth` and `next/cache` are mocked at file scope (vi.mock is hoisted), the
// same way admin-move-session-action.test.ts does it.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, coachRateOverrides, rateDefaults } from "@/db/schema";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

const authMock = vi.fn();
vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

// The public actions call revalidatePath() after a successful write. Outside
// a Next.js request that throws, which would hide the success being asserted.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

type ResourceType = "cage" | "bullpen" | "weight_room";
type DefaultsRow = {
  type: ResourceType;
  ratePer30MinCents: number;
  groupRatePer30MinCents: number | null;
};

let fixtures: FixtureUsers;
let snapshot: DefaultsRow[] = [];

async function restoreDefaults() {
  for (const row of snapshot) {
    await db
      .update(rateDefaults)
      .set({
        ratePer30MinCents: row.ratePer30MinCents,
        groupRatePer30MinCents: row.groupRatePer30MinCents,
      })
      .where(eq(rateDefaults.type, row.type));
  }
}

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  const rows = await db.select().from(rateDefaults);
  snapshot = rows.map((r) => ({
    type: r.type,
    ratePer30MinCents: r.ratePer30MinCents,
    groupRatePer30MinCents: r.groupRatePer30MinCents,
  }));
  // All three rows must exist: the Settings save would otherwise INSERT.
  expect(snapshot.map((r) => r.type).sort()).toEqual([
    "bullpen",
    "cage",
    "weight_room",
  ]);
});

beforeEach(async () => {
  await truncateMutables();
  authMock.mockReset();
  authMock.mockResolvedValue({
    user: {
      id: fixtures.admin.id,
      email: fixtures.admin.email,
      name: fixtures.admin.name,
      role: "admin",
    },
  });
});

afterEach(async () => {
  await restoreDefaults();
});

afterAll(async () => {
  await restoreDefaults();
});

async function readDefaults(): Promise<Map<ResourceType, DefaultsRow>> {
  const rows = await db.select().from(rateDefaults);
  return new Map(
    rows.map((r) => [
      r.type,
      {
        type: r.type,
        ratePer30MinCents: r.ratePer30MinCents,
        groupRatePer30MinCents: r.groupRatePer30MinCents,
      },
    ]),
  );
}

// ── Settings: "Save defaults" ────────────────────────────────────────────

// The Settings card's form as it is now: three rate inputs, no group field.
// Each input holds the stored rate the way the card renders it (cage and
// bullpen per 30 min, weight room per HOUR), so this is "press Save defaults
// without touching anything".
function settingsFormAsRendered(
  stored: Map<ResourceType, DefaultsRow>,
): FormData {
  const fd = new FormData();
  fd.set("cageDollars", (stored.get("cage")!.ratePer30MinCents / 100).toFixed(2));
  fd.set(
    "bullpenDollars",
    (stored.get("bullpen")!.ratePer30MinCents / 100).toFixed(2),
  );
  fd.set(
    "weightRoomDollars",
    ((stored.get("weight_room")!.ratePer30MinCents * 2) / 100).toFixed(2),
  );
  return fd;
}

async function saveDefaults(fd: FormData) {
  const mod = await import("@/app/admin/settings/form-actions");
  return mod.updateRateDefaultsFormAction({ ok: true, savedAt: 0 }, fd);
}

describe("Settings, Default rental rates: Save defaults without the group field", () => {
  it("clears a stored facility group default to NULL and leaves every rate as it was", async () => {
    await db
      .update(rateDefaults)
      .set({ groupRatePer30MinCents: 800 })
      .where(eq(rateDefaults.type, "weight_room"));
    const before = await readDefaults();
    expect(before.get("weight_room")!.groupRatePer30MinCents).toBe(800);

    const fd = settingsFormAsRendered(before);
    expect(fd.has("weightRoomGroupDollars")).toBe(false);
    const result = await saveDefaults(fd);
    expect(result).toMatchObject({ ok: true });

    const after = await readDefaults();
    expect(after.get("weight_room")!.groupRatePer30MinCents).toBeNull();
    for (const type of ["cage", "bullpen", "weight_room"] as const) {
      expect(after.get(type)!.ratePer30MinCents).toBe(
        before.get(type)!.ratePer30MinCents,
      );
    }

    // One audit entry, on the weight room row, recording the clear.
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "rate_default"));
    expect(audits).toHaveLength(1);
    expect(audits[0].entityId).toBe("weight_room");
    const diff = audits[0].diff as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    expect(diff.before.groupRatePer30MinCents).toBe(800);
    expect(diff.after.groupRatePer30MinCents).toBeNull();
  });

  it("a second Save defaults with nothing stored writes nothing", async () => {
    await db
      .update(rateDefaults)
      .set({ groupRatePer30MinCents: null })
      .where(eq(rateDefaults.type, "weight_room"));
    const before = await readDefaults();

    const result = await saveDefaults(settingsFormAsRendered(before));
    expect(result).toMatchObject({ ok: true });

    const after = await readDefaults();
    expect(after.get("weight_room")!.groupRatePer30MinCents).toBeNull();
    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "rate_default"));
    expect(audits).toHaveLength(0);
  });

  it("control: the same action given a group field still sets it ($16/hour = 800 per 30 min)", async () => {
    await db
      .update(rateDefaults)
      .set({ groupRatePer30MinCents: null })
      .where(eq(rateDefaults.type, "weight_room"));
    const fd = settingsFormAsRendered(await readDefaults());
    fd.set("weightRoomGroupDollars", "16");

    const result = await saveDefaults(fd);
    expect(result).toMatchObject({ ok: true });
    const after = await readDefaults();
    expect(after.get("weight_room")!.groupRatePer30MinCents).toBe(800);
  });
});

// ── Coach profile: Rate overrides, weight room Save ──────────────────────

async function saveCoachOverride(fd: FormData) {
  const mod = await import("@/app/admin/coaches/[id]/form-actions");
  return mod.upsertRateOverrideFormAction({ ok: true }, fd);
}

// The weight room row's form as it is now: coach, type, the rate (per HOUR),
// no group field.
function coachWeightRoomForm(rateDollarsPerHour: string): FormData {
  const fd = new FormData();
  fd.set("coachId", fixtures.coach.id);
  fd.set("resourceType", "weight_room");
  fd.set("rateDollars", rateDollarsPerHour);
  return fd;
}

async function readCoachOverride(resourceType: ResourceType) {
  const [row] = await db
    .select()
    .from(coachRateOverrides)
    .where(
      and(
        eq(coachRateOverrides.coachId, fixtures.coach.id),
        eq(coachRateOverrides.resourceType, resourceType),
      ),
    );
  return row;
}

describe("Coach profile, Rate overrides: a weight room Save without the group field", () => {
  it("clears the coach's stored group override to NULL and saves the regular rate as typed", async () => {
    await db.insert(coachRateOverrides).values({
      coachId: fixtures.coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 350,
      groupRatePer30MinCents: 1600,
    });

    const fd = coachWeightRoomForm("7.00");
    expect(fd.has("groupRateDollars")).toBe(false);
    const result = await saveCoachOverride(fd);
    expect(result).toEqual({ ok: true });

    const row = await readCoachOverride("weight_room");
    expect(row.ratePer30MinCents).toBe(350);
    expect(row.groupRatePer30MinCents).toBeNull();
  });

  it("control: the same action given a group field still sets it ($32/hour = 1600 per 30 min)", async () => {
    await db.insert(coachRateOverrides).values({
      coachId: fixtures.coach.id,
      resourceType: "weight_room",
      ratePer30MinCents: 350,
      groupRatePer30MinCents: null,
    });

    const fd = coachWeightRoomForm("7.00");
    fd.set("groupRateDollars", "32");
    const result = await saveCoachOverride(fd);
    expect(result).toEqual({ ok: true });

    const row = await readCoachOverride("weight_room");
    expect(row.groupRatePer30MinCents).toBe(1600);
  });
});
