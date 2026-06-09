// Integration tests for src/lib/server/rate-defaults-actions.ts.
// Same direct-internal pattern as the other suites. The public
// wrapper in src/app/admin/settings/actions.ts adds requireRole(
// "admin") (covered in admin-actions-authz.test.ts) and
// revalidatePath.
//
// rate_defaults is NOT in truncateMutables — it's a seeded singleton
// keyed by `type`. This suite snapshots all three rows in beforeAll
// and restores them in afterEach so tests don't leak across runs or
// permanently disturb the seed.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, rateDefaults, sessionsBilling, users } from "@/db/schema";
import { updateRateDefaultsInternal } from "@/lib/server/rate-defaults-actions";
import { createSessionInternal } from "@/lib/server/session-actions";
import {
  ensureFixtureUsers,
  getSeededResources,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

let fixtures: FixtureUsers;
let seeded: Awaited<ReturnType<typeof getSeededResources>>;
let snapshot: Array<{ type: string; ratePer30MinCents: number }> = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
  seeded = await getSeededResources();
  const rows = await db.select().from(rateDefaults);
  snapshot = rows.map((r) => ({
    type: r.type,
    ratePer30MinCents: r.ratePer30MinCents,
  }));
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  // Restore the seeded defaults exactly. Use update-only (no upsert)
  // — beforeAll already confirmed all three rows exist.
  for (const row of snapshot) {
    await db
      .update(rateDefaults)
      .set({ ratePer30MinCents: row.ratePer30MinCents })
      .where(eq(rateDefaults.type, row.type as "cage" | "bullpen" | "weight_room"));
  }
});

function uniqueEmail(label: string): string {
  return `rd-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.invalid`;
}

async function createThrowawayCoach(name = "Defaults Test Coach") {
  const [row] = await db
    .insert(users)
    .values({ email: uniqueEmail("coach"), name, role: "coach" })
    .returning();
  return row;
}

function tomorrowAt(hour: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

describe("updateRateDefaultsInternal", () => {
  it("updates all three rates and writes one audit row per changed type", async () => {
    await updateRateDefaultsInternal(fixtures.admin, {
      cageDollars: "25",
      bullpenDollars: "30",
      weightRoomDollars: "10",
    });

    const rows = await db.select().from(rateDefaults);
    const byType = new Map(rows.map((r) => [r.type, r.ratePer30MinCents]));
    expect(byType.get("cage")).toBe(2500);
    expect(byType.get("bullpen")).toBe(3000);
    expect(byType.get("weight_room")).toBe(1000);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityType, "rate_default"));
    // All three types are likely changing from the seeded values, so
    // we expect 3 audit rows. If the seed happens to match exactly,
    // there'd be 0 — but the canonical seed is cage 2200, bullpen
    // 2200, weight_room 700; all three differ from our test values.
    expect(audits.length).toBe(3);
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toEqual(["update", "update", "update"]);
  });

  it("skips audit + DB write for types whose rate already matches", async () => {
    // Seeded cage rate is 2200. Bullpen is 2200. Weight room is 700.
    // Change only weight_room; cage + bullpen should match seed and
    // therefore be no-ops.
    await updateRateDefaultsInternal(fixtures.admin, {
      cageDollars: "22",
      bullpenDollars: "22",
      weightRoomDollars: "8",
    });

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
    expect(diff.before.ratePer30MinCents).toBe(700);
    expect(diff.after.ratePer30MinCents).toBe(800);
  });

  it("accepts dollars with leading $ and decimal cents", async () => {
    await updateRateDefaultsInternal(fixtures.admin, {
      cageDollars: "$25.50",
      bullpenDollars: "$30.00",
      weightRoomDollars: "10.25",
    });
    const rows = await db.select().from(rateDefaults);
    const byType = new Map(rows.map((r) => [r.type, r.ratePer30MinCents]));
    expect(byType.get("cage")).toBe(2550);
    expect(byType.get("bullpen")).toBe(3000);
    expect(byType.get("weight_room")).toBe(1025);
  });

  it("rejects malformed dollar strings", async () => {
    await expect(
      updateRateDefaultsInternal(fixtures.admin, {
        cageDollars: "twenty",
        bullpenDollars: "22",
        weightRoomDollars: "7",
      }),
    ).rejects.toThrow();
    await expect(
      updateRateDefaultsInternal(fixtures.admin, {
        cageDollars: "22.555",
        bullpenDollars: "22",
        weightRoomDollars: "7",
      }),
    ).rejects.toThrow();
    await expect(
      updateRateDefaultsInternal(fixtures.admin, {
        cageDollars: "",
        bullpenDollars: "22",
        weightRoomDollars: "7",
      }),
    ).rejects.toThrow();
  });

  it("rejects out-of-range dollar values", async () => {
    await expect(
      updateRateDefaultsInternal(fixtures.admin, {
        cageDollars: "9999",
        bullpenDollars: "22",
        weightRoomDollars: "7",
      }),
    ).rejects.toThrow();
  });

  it("does NOT retroactively change snapshotted rates on existing sessions", async () => {
    // Same snapshot-rule contract as overrides — defaults change only
    // affects future sessions logged WITHOUT a matching per-coach
    // override. Locking in via CI per E14 of the 2026-05-25 audit.
    const coach = await createThrowawayCoach();

    const session = await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect(session.ratePer30MinCents).toBe(2200); // seeded cage default

    await updateRateDefaultsInternal(fixtures.admin, {
      cageDollars: "30",
      bullpenDollars: "22",
      weightRoomDollars: "7",
    });

    const [persisted] = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.id, session.id));
    expect(persisted.ratePer30MinCents).toBe(2200);
  });

  it("future sessions pick up the new default after the update", async () => {
    const coach = await createThrowawayCoach();

    await updateRateDefaultsInternal(fixtures.admin, {
      cageDollars: "30",
      bullpenDollars: "22",
      weightRoomDollars: "7",
    });

    const session = await createSessionInternal(fixtures.admin, {
      coachId: coach.id,
      resourceId: seeded.cage1.id,
      startAt: tomorrowAt(10),
      endAt: tomorrowAt(11),
    });
    expect(session.ratePer30MinCents).toBe(3000);
  });
});

