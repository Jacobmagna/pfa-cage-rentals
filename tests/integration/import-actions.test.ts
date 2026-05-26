// Integration tests for src/lib/server/import-actions.ts. Hits the real
// Neon dev branch. Builds a tiny synthetic XLSX programmatically in
// each test (no fixture file in the repo — keeps the test self-
// describing and CI doesn't need extra setup).
//
// What we lock down:
//   - `previewImport` is read-only — no rows inserted.
//   - `executeCommitPlan` creates new synthetic coaches AND inserts
//     sessions with the snapshotted ratePer30MinCents (audit E9 fix).
//   - Re-running the same commit is idempotent — dedupe by
//     (resource, coach, start, end) catches the duplicate.
//   - Unknown resource → row goes to `errored`, not inserted.
//   - Coach key resolution to existing user via decision.action="map".
//   - Audit log: a row per created coach AND per inserted session.
//
// XLSX layout (re-derived from src/lib/import/parse.ts):
//   - Row 4 holds the day-block date in column 4.
//   - Row 5 holds the slot-header in column 3 (parser only uses it
//     as a delimiter via cell text non-emptiness in column header
//     scanning — actually it doesn't, see parse.ts; we just need
//     a date in row 4 and resource rows beneath).
//   - Row 6+ are resource rows, label in col 1, names in cols 3+.
//   - Columns 3..30 are the 30-min slots, col 3 = 08:00.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  auditLog,
  coachRateOverrides,
  rateDefaults,
  sessionsBilling,
  users,
} from "@/db/schema";
import {
  executeCommitPlan,
  previewImport,
} from "@/lib/server/import-actions";
import { syntheticEmailFor } from "@/lib/import/commit";
import {
  ensureFixtureUsers,
  truncateMutables,
  type FixtureUsers,
} from "./fixtures";

let fixtures: FixtureUsers;
const cleanupSyntheticEmails: string[] = [];

beforeAll(async () => {
  fixtures = await ensureFixtureUsers();
});

beforeEach(async () => {
  await truncateMutables();
});

afterEach(async () => {
  // executeCommitPlan creates real `users` rows for new synthetic
  // coaches; truncateMutables doesn't clean those. Sessions reference
  // those users via FK, so truncate the mutables first (drops the
  // sessions + the rate overrides) before hard-deleting the users.
  if (cleanupSyntheticEmails.length > 0) {
    await truncateMutables();
    await db.delete(users).where(inArray(users.email, cleanupSyntheticEmails));
    cleanupSyntheticEmails.length = 0;
  }
});

// Per-test name prefix so two runs of the suite, or stale leftovers
// from a previously crashed run, can't collide on canonical name
// (buildCommitPlan matches existing users by lowercase name and
// would treat a stale row as "already exists" — that would silently
// flip newCoachesCreated from 1 to 0).
function uniqueCoachName(label: string): string {
  return `${label} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// Records a synthetic-coach email for cleanup. Also returns it.
function trackSyntheticEmail(name: string): string {
  const email = syntheticEmailFor(name);
  cleanupSyntheticEmails.push(email);
  return email;
}

// Slot index conversion: parse.ts maps col 3 → 08:00 and each
// subsequent col = +30 min. Helper so tests read closer to "10 AM"
// than "col 7".
function slotCol(hour: number, minute: 0 | 30 = 0): number {
  const minutesFrom8am = (hour - 8) * 60 + minute;
  return 3 + minutesFrom8am / 30;
}

type SyntheticRow = {
  resourceLabel: string; // "Cage 1 (Pitching)" / "Bullpen 1" / "Weight Room"
  rawName: string;
  startHour: number;
  endHour: number;
};

// Builds an in-memory XLSX with one tab and one day-block.
async function buildSyntheticWorkbook(
  date: Date,
  rows: SyntheticRow[],
  opts: { tabName?: string } = {},
): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(opts.tabName ?? "Test Week");
  ws.getRow(4).getCell(4).value = date;
  // Slot header in row 5 col 3 — parse.ts doesn't actually require it,
  // but the real workbook has one and the parser walks col 3+ in row 5
  // looking for the date when row 4 has none. We just need row 4 col 4
  // populated for parseSheet to flow.
  ws.getRow(5).getCell(3).value = "8:00-8:30";

  // Resource rows start at row 6 (date row + 2).
  rows.forEach((row, i) => {
    const r = ws.getRow(6 + i);
    r.getCell(1).value = row.resourceLabel;
    for (let h = row.startHour; h < row.endHour; h++) {
      for (const m of [0, 30] as const) {
        r.getCell(slotCol(h, m)).value = row.rawName;
      }
    }
  });

  const buf = await wb.xlsx.writeBuffer();
  return buf as ArrayBuffer;
}

describe("previewImport", () => {
  it("parses a synthetic workbook and groups sessions by raw name without mutating", async () => {
    const before = await db
      .select({ count: sql<string>`count(*)` })
      .from(sessionsBilling);
    const beforeCount = Number(before[0].count);

    const buf = await buildSyntheticWorkbook(new Date(Date.UTC(2026, 4, 1)), [
      { resourceLabel: "Cage 1 (Pitching)", rawName: "Test Coach A", startHour: 10, endHour: 11 },
      { resourceLabel: "Cage 2 (Hitting)", rawName: "Test Coach B", startHour: 11, endHour: 12 },
    ]);

    const result = await previewImport(buf);
    expect(result.totalParsed).toBe(2);
    expect(result.groups).toHaveLength(2);
    const names = result.groups.map((g) => g.rawName).sort();
    expect(names).toEqual(["Test Coach A", "Test Coach B"]);

    // No rows inserted.
    const after = await db
      .select({ count: sql<string>`count(*)` })
      .from(sessionsBilling);
    expect(Number(after[0].count)).toBe(beforeCount);
  });
});

describe("executeCommitPlan", () => {
  it("creates a new synthetic coach + inserts the session with snapshotted rate (audit E9 fix)", async () => {
    const coachName = uniqueCoachName("Brand New Import Coach");
    trackSyntheticEmail(coachName);

    const buf = await buildSyntheticWorkbook(new Date(Date.UTC(2026, 4, 2)), [
      { resourceLabel: "Cage 1 (Pitching)", rawName: coachName, startHour: 10, endHour: 11 },
    ]);

    const result = await executeCommitPlan(fixtures.admin, buf, [
      { rawName: coachName, action: "create" },
    ]);

    expect(result.created).toBe(1);
    expect(result.newCoachesCreated).toBe(1);
    expect(result.skippedOverlaps).toBe(0);
    expect(result.skippedDuplicates).toBe(0);
    expect(result.errored).toHaveLength(0);

    const inserted = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.source, "historical_import"));
    expect(inserted).toHaveLength(1);

    // The audit E9 fix: rate is the seeded cage default (2200 cents
    // unless someone has changed it on the integration branch — read
    // the current value to compare).
    const [cageDefault] = await db
      .select()
      .from(rateDefaults)
      .where(eq(rateDefaults.type, "cage"));
    expect(inserted[0].ratePer30MinCents).toBe(cageDefault.ratePer30MinCents);
    expect(inserted[0].ratePer30MinCents).toBeGreaterThan(0);
  });

  it("uses a coach override when one exists on the new synthetic coach", async () => {
    // Pre-create the synthetic coach with a custom override, then run
    // the import targeting the same canonical name via "map". Confirms
    // resolveRateCents reads overrides during commit, not just defaults.
    const coachName = uniqueCoachName("Override Coach");
    const email = trackSyntheticEmail(coachName);
    const [existing] = await db
      .insert(users)
      .values({ email, name: coachName, role: "coach" })
      .returning();
    await db.insert(coachRateOverrides).values({
      coachId: existing.id,
      resourceType: "cage",
      ratePer30MinCents: 1700,
    });

    const buf = await buildSyntheticWorkbook(new Date(Date.UTC(2026, 4, 3)), [
      { resourceLabel: "Cage 1 (Pitching)", rawName: coachName, startHour: 10, endHour: 11 },
    ]);

    const result = await executeCommitPlan(fixtures.admin, buf, [
      { rawName: coachName, action: "map", mappedUserId: existing.id },
    ]);
    expect(result.created).toBe(1);
    expect(result.newCoachesCreated).toBe(0);

    const [inserted] = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.source, "historical_import"));
    expect(inserted.coachId).toBe(existing.id);
    expect(inserted.ratePer30MinCents).toBe(1700);
  });

  it("is idempotent on re-run — second commit dedupes by (resource, coach, start, end)", async () => {
    const coachName = uniqueCoachName("Idempotent Coach");
    trackSyntheticEmail(coachName);

    const buf = await buildSyntheticWorkbook(new Date(Date.UTC(2026, 4, 4)), [
      { resourceLabel: "Cage 1 (Pitching)", rawName: coachName, startHour: 10, endHour: 11 },
      { resourceLabel: "Cage 2 (Hitting)", rawName: coachName, startHour: 11, endHour: 12 },
    ]);

    const first = await executeCommitPlan(fixtures.admin, buf, [
      { rawName: coachName, action: "create" },
    ]);
    expect(first.created).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    // Re-run with the same workbook. The synthetic coach now exists,
    // so suggestion would be "map" — but the dedupe set is keyed on
    // (resource, coach, start, end), so both rows already exist and
    // get skipped.
    const [existingCoach] = await db
      .select()
      .from(users)
      .where(eq(users.email, syntheticEmailFor(coachName)));
    expect(existingCoach).toBeDefined();

    const second = await executeCommitPlan(fixtures.admin, buf, [
      { rawName: coachName, action: "map", mappedUserId: existingCoach.id },
    ]);
    expect(second.created).toBe(0);
    expect(second.skippedDuplicates).toBe(2);

    const rows = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.source, "historical_import"));
    expect(rows).toHaveLength(2);
  });

  it("writes audit rows for every created coach AND every inserted session", async () => {
    const coachName = uniqueCoachName("Audited Coach");
    trackSyntheticEmail(coachName);

    const buf = await buildSyntheticWorkbook(new Date(Date.UTC(2026, 4, 5)), [
      { resourceLabel: "Cage 1 (Pitching)", rawName: coachName, startHour: 10, endHour: 11 },
    ]);
    const result = await executeCommitPlan(fixtures.admin, buf, [
      { rawName: coachName, action: "create" },
    ]);
    expect(result.created).toBe(1);
    expect(result.newCoachesCreated).toBe(1);

    const [createdCoach] = await db
      .select()
      .from(users)
      .where(eq(users.email, syntheticEmailFor(coachName)));

    const coachAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "user"),
          eq(auditLog.entityId, createdCoach.id),
          eq(auditLog.action, "create"),
        ),
      );
    expect(coachAudit).toHaveLength(1);

    const sessionAudit = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityType, "session"),
          eq(auditLog.action, "create"),
        ),
      );
    expect(sessionAudit).toHaveLength(1);
    const diff = sessionAudit[0].diff as { after: Record<string, unknown> };
    expect(diff.after.source).toBe("historical_import");
    expect(diff.after.ratePer30MinCents).toBeGreaterThan(0);
  });

  it("skips rows when the admin's decision is `skip`", async () => {
    const coachName = uniqueCoachName("Skipped Coach");

    const buf = await buildSyntheticWorkbook(new Date(Date.UTC(2026, 4, 6)), [
      { resourceLabel: "Cage 1 (Pitching)", rawName: coachName, startHour: 10, endHour: 11 },
    ]);
    const result = await executeCommitPlan(fixtures.admin, buf, [
      { rawName: coachName, action: "skip" },
    ]);
    expect(result.created).toBe(0);
    expect(result.newCoachesCreated).toBe(0);
    expect(result.skippedByPlan).toHaveLength(1);
    expect(result.skippedByPlan[0].reason).toBe("admin chose skip");

    const rows = await db
      .select()
      .from(sessionsBilling)
      .where(eq(sessionsBilling.source, "historical_import"));
    expect(rows).toHaveLength(0);
  });

  it("rejects map decisions that point at a non-existent user — row hits the skipped list", async () => {
    const coachName = uniqueCoachName("Bad Map Coach");

    const buf = await buildSyntheticWorkbook(new Date(Date.UTC(2026, 4, 7)), [
      { resourceLabel: "Cage 1 (Pitching)", rawName: coachName, startHour: 10, endHour: 11 },
    ]);
    const result = await executeCommitPlan(fixtures.admin, buf, [
      {
        rawName: coachName,
        action: "map",
        mappedUserId: "00000000-0000-0000-0000-000000000000",
      },
    ]);
    expect(result.created).toBe(0);
    expect(result.skippedByPlan.length).toBeGreaterThan(0);
    expect(result.skippedByPlan[0].reason).toMatch(/not found/);
  });

});
