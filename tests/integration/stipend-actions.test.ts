// Integration tests for src/lib/server/stipend-actions.ts (stipend SPEC §6,
// Phase B3). Same direct-internal pattern as rate-override-actions.test.ts:
// the public "use server" wrapper adds only requireRole("admin") and
// revalidatePath.
//
// 🔴 WHAT THIS FILE EXISTS TO LOCK DOWN, in order of how much money it costs
// if it breaks:
//
//   1. NON-OVERLAP AT THE DATABASE LEVEL. Two `coach_stipends` windows that
//      overlap pay a coach twice for the same half-month. The planner is
//      unit-tested with literals; this file proves the property survives the
//      round trip through Postgres — the windows really do meet, and the
//      close and the insert really do land together.
//
//   2. A REFUSAL WRITES NOTHING. Every guard throws before any statement
//      runs, so a rejected save must leave the row count and the audit trail
//      exactly as they were. Under neon-http there is no transaction to roll
//      back, so "refuse before writing" is the only thing standing between a
//      bad input and a half-applied change.
//
//   3. THE AUDIT NAMES THE BACKDATE. §12.4's risk is the app newly claiming
//      money is owed that Mark may already have settled in cash. The audit
//      row is the only durable record that an admin was shown that warning
//      and accepted it.

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, coachStipends } from "@/db/schema";
import { CoachNotFoundError } from "@/lib/errors";
import { parsePfaInput } from "@/lib/timezone";
import { StipendPlanError } from "@/lib/stipend/engine";
import {
  cancelCoachStipendInternal,
  endCoachStipendInternal,
  fetchCoachStipendVersions,
  fetchCurrentCoachStipend,
  setCoachStipendInternal,
  STIPEND_ENTITY_TYPE,
} from "@/lib/server/stipend-actions";
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

/** PFA-midnight on a pay-period boundary. */
function boundary(date: string): Date {
  return parsePfaInput(date, "00:00");
}

/** Aug 20 2026, 11:00 AM PFA — inside 2026-08-P2. Every `now` below. */
const NOW = parsePfaInput("2026-08-20", "11:00");

const SEP_1 = boundary("2026-09-01");
const SEP_16 = boundary("2026-09-16");
const OCT_1 = boundary("2026-10-01");
const AUG_16 = boundary("2026-08-16");

async function rowsFor(coachId: string) {
  return db
    .select()
    .from(coachStipends)
    .where(eq(coachStipends.coachId, coachId));
}

async function stipendAuditRows(coachId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, STIPEND_ENTITY_TYPE),
        eq(auditLog.entityId, coachId),
      ),
    );
}

describe("setCoachStipendInternal — the first version", () => {
  it("writes one open row and audits it as a create", async () => {
    const { admin, coach } = fixtures;

    const { row, closedVersionId } = await setCoachStipendInternal(
      admin,
      {
        coachId: coach.id,
        amountCents: 250_000,
        effectiveFrom: SEP_1,
        note: "Manager work — Nick",
      },
      NOW,
    );

    expect(row.amountCents).toBe(250_000);
    expect(row.effectiveFrom.getTime()).toBe(SEP_1.getTime());
    expect(row.effectiveTo).toBeNull();
    expect(row.createdBy).toBe(admin.id);
    expect(closedVersionId).toBeNull();

    const audits = await stipendAuditRows(coach.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("create");
    expect(audits[0].actorUserId).toBe(admin.id);
  });

  it("fetchCurrentCoachStipend returns the open row", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );
    const current = await fetchCurrentCoachStipend(coach.id);
    expect(current?.amountCents).toBe(250_000);
  });

  it("returns null for a coach who has never had one", async () => {
    expect(await fetchCurrentCoachStipend(fixtures.coach.id)).toBeNull();
  });
});

describe("setCoachStipendInternal — versioning", () => {
  it("🔴 closes the prior version at exactly the new one's start", async () => {
    const { admin, coach } = fixtures;

    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );
    const second = await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 300_000, effectiveFrom: OCT_1 },
      NOW,
    );

    const versions = await fetchCoachStipendVersions(coach.id);
    expect(versions).toHaveLength(2);

    const [first, latest] = versions;
    // The windows MEET. Anything else is a gap (a period earns nothing) or an
    // overlap (a period earns twice).
    expect(first.effectiveTo?.getTime()).toBe(OCT_1.getTime());
    expect(latest.effectiveFrom.getTime()).toBe(OCT_1.getTime());
    expect(latest.effectiveTo).toBeNull();
    expect(second.closedVersionId).toBe(first.id);
  });

  it("🔴 leaves EXACTLY ONE open row after any number of changes", async () => {
    const { admin, coach } = fixtures;
    const dates = [SEP_1, SEP_16, OCT_1, boundary("2026-10-16")];
    for (const [i, d] of dates.entries()) {
      await setCoachStipendInternal(
        admin,
        { coachId: coach.id, amountCents: 200_000 + i * 10_000, effectiveFrom: d },
        NOW,
      );
    }

    const versions = await fetchCoachStipendVersions(coach.id);
    expect(versions).toHaveLength(4);
    expect(versions.filter((v) => v.effectiveTo === null)).toHaveLength(1);

    // 🔴 The property itself, checked over the real rows rather than inferred
    // from the planner: no two windows overlap. Read as a person would — walk
    // them in order and assert each one starts where the last ended.
    for (let i = 1; i < versions.length; i += 1) {
      const prevEnd = versions[i - 1].effectiveTo;
      expect(prevEnd).not.toBeNull();
      expect(prevEnd!.getTime()).toBe(versions[i].effectiveFrom.getTime());
    }
  });

  it("audits a version change as an update naming the closed row", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 300_000, effectiveFrom: OCT_1 },
      NOW,
    );

    const audits = await stipendAuditRows(coach.id);
    expect(audits).toHaveLength(2);
    const update = audits.find((a) => a.action === "update");
    expect(update).toBeDefined();
    const diff = update!.diff as { after?: Record<string, unknown> };
    expect(diff.after?.closedVersionId).toBeTruthy();
    expect(diff.after?.amountCents).toBe(300_000);
  });
});

describe("a refusal writes NOTHING", () => {
  it("refuses a start in the same period as a STARTED version, and leaves the table untouched", async () => {
    // ⚠️ THE FIXTURE IS THE POINT. This used SEP_1 — a FUTURE period, since
    // NOW is Aug 20 — so it asserted that a stipend set up in advance could
    // never be corrected before it paid. That was the defect, not the guard.
    // AUG_16 is under way at NOW, which is what forward-only exists to refuse.
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: AUG_16, confirmBackdate: true },
      NOW,
    );
    const before = await rowsFor(coach.id);
    const auditsBefore = await stipendAuditRows(coach.id);

    await expect(
      setCoachStipendInternal(
        admin,
        { coachId: coach.id, amountCents: 999_999, effectiveFrom: AUG_16, confirmBackdate: true },
        NOW,
      ),
    ).rejects.toBeInstanceOf(StipendPlanError);

    const after = await rowsFor(coach.id);
    expect(after).toHaveLength(before.length);
    expect(after[0].amountCents).toBe(250_000);
    expect(await stipendAuditRows(coach.id)).toHaveLength(auditsBefore.length);
  });

  it("refuses an unconfirmed backdate and leaves the table untouched", async () => {
    const { admin, coach } = fixtures;

    await expect(
      setCoachStipendInternal(
        admin,
        { coachId: coach.id, amountCents: 250_000, effectiveFrom: AUG_16 },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "BACKDATE_NOT_CONFIRMED" });

    expect(await rowsFor(coach.id)).toHaveLength(0);
    expect(await stipendAuditRows(coach.id)).toHaveLength(0);
  });

  it("refuses a non-boundary date and leaves the table untouched", async () => {
    const { admin, coach } = fixtures;
    await expect(
      setCoachStipendInternal(
        admin,
        {
          coachId: coach.id,
          amountCents: 250_000,
          effectiveFrom: boundary("2026-09-07"),
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NOT_PERIOD_START" });
    expect(await rowsFor(coach.id)).toHaveLength(0);
  });

  it("refuses a $0 stipend", async () => {
    const { admin, coach } = fixtures;
    // Caught at the zod boundary before the planner is even reached — both
    // layers state the rule, deliberately.
    await expect(
      setCoachStipendInternal(
        admin,
        { coachId: coach.id, amountCents: 0, effectiveFrom: SEP_1 },
        NOW,
      ),
    ).rejects.toThrow();
    expect(await rowsFor(coach.id)).toHaveLength(0);
  });

  it("refuses an unknown coach with CoachNotFoundError, not an FK violation", async () => {
    await expect(
      setCoachStipendInternal(
        fixtures.admin,
        {
          coachId: "00000000-0000-0000-0000-000000000000",
          amountCents: 250_000,
          effectiveFrom: SEP_1,
        },
        NOW,
      ),
    ).rejects.toBeInstanceOf(CoachNotFoundError);
  });
});

describe("the §12.4 back-pay guard, confirmed", () => {
  it("applies a confirmed backdate and records the periods in the audit", async () => {
    const { admin, coach } = fixtures;

    const { row } = await setCoachStipendInternal(
      admin,
      {
        coachId: coach.id,
        amountCents: 250_000,
        effectiveFrom: AUG_16,
        confirmBackdate: true,
      },
      NOW,
    );
    expect(row.effectiveFrom.getTime()).toBe(AUG_16.getTime());

    const audits = await stipendAuditRows(coach.id);
    const diff = audits[0].diff as { after?: Record<string, unknown> };
    // 🔴 The only durable evidence an admin was warned and accepted it.
    expect(diff.after?.backdatedPeriodKeys).toEqual(["2026-08-P2"]);
  });

  it("records an EMPTY period list on a normal forward-dated save", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );
    const audits = await stipendAuditRows(coach.id);
    const diff = audits[0].diff as { after?: Record<string, unknown> };
    expect(diff.after?.backdatedPeriodKeys).toEqual([]);
  });
});

describe("endCoachStipendInternal", () => {
  it("closes the open version and leaves no open row", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );

    const { row } = await endCoachStipendInternal(
      admin,
      { coachId: coach.id, effectiveTo: OCT_1 },
      NOW,
    );
    expect(row.effectiveTo?.getTime()).toBe(OCT_1.getTime());
    expect(await fetchCurrentCoachStipend(coach.id)).toBeNull();
  });

  it("refuses a second end — there is nothing open", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );
    await endCoachStipendInternal(
      admin,
      { coachId: coach.id, effectiveTo: OCT_1 },
      NOW,
    );
    await expect(
      endCoachStipendInternal(
        admin,
        { coachId: coach.id, effectiveTo: boundary("2026-10-16") },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "NO_OPEN_VERSION" });
  });

  it("🔴 REPLACES a not-yet-started version in place — one row, not two", async () => {
    // The correction path, end to end against the real table. The delete and
    // the insert ride in ONE batch, so there is never an instant with two
    // overlapping future versions — and never one with none.
    //
    // This is the Sept 1 rollout's most likely mistake: Mark sets a coach up
    // in August, mistypes the amount, and needs it fixed before it pays. It
    // used to be unfixable — forward-only refused the re-set, and the end
    // guard refused to close a window that had not opened.
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 900_000, effectiveFrom: SEP_1 },
      NOW,
    );
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );

    const versions = await fetchCoachStipendVersions(coach.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].amountCents).toBe(250_000);
    expect(versions[0].effectiveFrom.getTime()).toBe(SEP_1.getTime());
    expect(versions[0].effectiveTo).toBeNull();
  });

  it("🔴 cancelling a not-yet-started stipend REOPENS what it displaced", async () => {
    // Without the reopen, cancelling a September change would leave August
    // closed off at a boundary that no longer exists — the coach on NO
    // stipend at all, a silent pay cut produced by an undo.
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 200_000, effectiveFrom: AUG_16, confirmBackdate: true },
      NOW,
    );
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 900_000, effectiveFrom: SEP_1 },
      NOW,
    );
    await cancelCoachStipendInternal(admin, { coachId: coach.id }, NOW);

    const versions = await fetchCoachStipendVersions(coach.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].amountCents).toBe(200_000);
    // 🔴 Reopened. The August version runs on, exactly as it did before the
    // September change was ever entered.
    expect(versions[0].effectiveTo).toBeNull();
  });

  it("refuses to cancel a stipend that has already started", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: AUG_16, confirmBackdate: true },
      NOW,
    );
    await expect(
      cancelCoachStipendInternal(admin, { coachId: coach.id }, NOW),
    ).rejects.toBeInstanceOf(StipendPlanError);

    const versions = await fetchCoachStipendVersions(coach.id);
    expect(versions).toHaveLength(1);
  });

  it("lets a coach be put BACK on a stipend after ending, with no overlap", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );
    await endCoachStipendInternal(
      admin,
      { coachId: coach.id, effectiveTo: OCT_1 },
      NOW,
    );
    await setCoachStipendInternal(
      admin,
      {
        coachId: coach.id,
        amountCents: 400_000,
        effectiveFrom: boundary("2026-11-01"),
      },
      NOW,
    );

    const versions = await fetchCoachStipendVersions(coach.id);
    expect(versions).toHaveLength(2);
    // 🔴 A real GAP here is correct — Oct 1 → Nov 1 the coach is off the
    // stipend. Ending must not be indistinguishable from changing the amount.
    expect(versions[0].effectiveTo?.getTime()).toBe(OCT_1.getTime());
    expect(versions[1].effectiveFrom.getTime()).toBe(
      boundary("2026-11-01").getTime(),
    );
    expect(versions[1].effectiveTo).toBeNull();
  });

  it("refuses an unconfirmed retroactive end and writes nothing", async () => {
    const { admin, coach } = fixtures;
    await setCoachStipendInternal(
      admin,
      {
        coachId: coach.id,
        amountCents: 250_000,
        effectiveFrom: boundary("2026-07-01"),
        confirmBackdate: true,
      },
      NOW,
    );

    await expect(
      endCoachStipendInternal(
        admin,
        { coachId: coach.id, effectiveTo: AUG_16 },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "BACKDATE_NOT_CONFIRMED" });

    const current = await fetchCurrentCoachStipend(coach.id);
    expect(current?.effectiveTo).toBeNull();
  });

  it("does not disturb another coach's stipend", async () => {
    const { admin, coach, flaggedCoach } = fixtures;
    await setCoachStipendInternal(
      admin,
      { coachId: coach.id, amountCents: 250_000, effectiveFrom: SEP_1 },
      NOW,
    );
    await setCoachStipendInternal(
      admin,
      { coachId: flaggedCoach.id, amountCents: 100_000, effectiveFrom: SEP_1 },
      NOW,
    );
    await endCoachStipendInternal(
      admin,
      { coachId: coach.id, effectiveTo: OCT_1 },
      NOW,
    );

    expect(await fetchCurrentCoachStipend(flaggedCoach.id)).not.toBeNull();
    expect(await fetchCurrentCoachStipend(coach.id)).toBeNull();
  });
});
