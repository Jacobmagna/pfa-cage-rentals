// E2E for ADMIN HOUR ENTRY — "Log hours for a coach" on /admin/hour-log.
//
// ── 🔴 WHY THIS FILE EXISTS ──────────────────────────────────────────────
// The dialog shipped to production on 2026-08-25 with NO automated coverage
// of any kind. Both defects found while building it were in this dialog and
// NEITHER was reachable by an assertion — a `<select>` that reverted on every
// re-render, and a dialog that stayed open over a blank form after the row
// had already been written. The only way to re-verify it was an untracked
// script in `scripts/qa/`, which is in no gate, so nothing stopped a later
// change from breaking it silently.
//
// The morning after it shipped, Mark recorded hours for the first of two
// coaches scheduled on one block and the dialog behaved oddly; entering the
// second coach FROZE on "Recording…". The server-side path is covered by
// `tests/integration/admin-hour-entry-multi-coach.test.ts` and is correct —
// two coaches at one window write two separate priced rows and the block
// stays red until both are logged. So the failure is at a seam only a
// browser crosses: hydration → useActionState → the server action → the
// close-on-success effect.
//
// This file crosses that seam in CI. It is deliberately a GOLDEN FLOW in the
// spirit of `coach-flow.spec.ts` — record hours, watch the dialog close,
// see the row — plus the one non-golden assertion that is the whole point:
// THE DIALOG MUST NOT STILL BE SUBMITTING when the action has finished.

import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db";
import {
  hourLogs,
  programScheduleBlocks,
  programs,
  sessions as authSessions,
  users,
} from "../../src/db/schema";

const ADMIN_EMAIL = "e2e-admin@pfa.invalid";
const COACH_A_EMAIL = "e2e-hours-coach-a@pfa.invalid";
const COACH_B_EMAIL = "e2e-hours-coach-b@pfa.invalid";

let adminId: string;
let coachAId: string;
let coachBId: string;
let programId: string;
let programName: string;
let sessionToken: string;

/**
 * A day comfortably in the past — the case the feature exists for, and the
 * one Mark hit: older than the coach's own 14-day confirm window, so an
 * admin entry is the only way the work can ever be paid.
 */
function pastDay(daysAgo: number): { iso: string; typed: string } {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { iso: `${yyyy}-${mm}-${dd}`, typed: `${mm}${dd}${yyyy}` };
}

async function upsertUser(
  email: string,
  name: string,
  role: "admin" | "coach",
): Promise<string> {
  await db
    .insert(users)
    .values({ email, name, role })
    .onConflictDoUpdate({
      target: users.email,
      // deletedAt: null — a prior suite may have tombstoned the fixture, and
      // every coach picker filters isNull(deletedAt).
      set: { role, name, deletedAt: null },
    });
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) throw new Error(`failed to upsert ${email}`);
  return row.id;
}

test.beforeAll(async () => {
  adminId = await upsertUser(ADMIN_EMAIL, "E2E Admin", "admin");
  coachAId = await upsertUser(COACH_A_EMAIL, "E2E Coach Alpha", "coach");
  coachBId = await upsertUser(COACH_B_EMAIL, "E2E Coach Bravo", "coach");

  programName = `E2E Hour Entry ${randomBytes(3).toString("hex")}`;
  const [program] = await db
    .insert(programs)
    .values({
      name: programName,
      active: true,
      defaultRatePer30MinCents: 1500,
    })
    .returning({ id: programs.id });
  programId = program.id;

  // 30 days, not hours — `sessions.expires` is a naive timestamp and the
  // round trip comes back the PFA offset out, which silently deletes a
  // short-lived session on first use (discipline rule 22).
  sessionToken = randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    sessionToken,
    userId: adminId,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
});

test.afterAll(async () => {
  await db
    .delete(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken));
  await db.delete(hourLogs).where(eq(hourLogs.programId, programId));
  await db
    .delete(programScheduleBlocks)
    .where(eq(programScheduleBlocks.programId, programId));
  await db.delete(programs).where(eq(programs.id, programId));
});

test.beforeEach(async ({ context }) => {
  await db.delete(hourLogs).where(eq(hourLogs.programId, programId));
  await db.execute(
    sql`TRUNCATE TABLE sessions_billing, blocked_times, audit_log RESTART IDENTITY CASCADE`,
  );
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: sessionToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
});

/**
 * Fills and submits the dialog once. Locators are by FIELD NAME rather than
 * by label text: the date field's accessible name comes from a wrapping
 * `<label>` and the two time fields have no `aria-label` at all, so
 * label-based lookup here would be matching on prose that a copy edit can
 * move (the class of breakage discipline rule 11 is about).
 */
async function recordHours(
  page: Page,
  opts: {
    coachName: string;
    program: string;
    typedDate: string;
    start: string;
    end: string;
  },
) {
  await page.getByRole("button", { name: "Log hours for a coach" }).click();

  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();

  await dialog.locator('select[name="coachId"]').selectOption({
    label: opts.coachName,
  });
  await dialog.locator('select[name="programId"]').selectOption({
    label: opts.program,
  });

  // The visible date field is a masked text input that only accepts DIGITS
  // and inserts the slashes itself, so type digits rather than fill().
  const dateField = dialog.locator('input[placeholder="MM/DD/YYYY"]');
  await dateField.click();
  await dateField.pressSequentially(opts.typedDate);

  await dialog.locator('select[name="startTime"]').selectOption(opts.start);
  await dialog.locator('select[name="endTime"]').selectOption(opts.end);

  await dialog.getByRole("button", { name: "Record hours" }).click();
}

test.describe("an admin records hours for two coaches on one block", () => {
  test("records both, closes the dialog each time, and never sticks on Recording…", async ({
    page,
  }) => {
    const day = pastDay(21);

    await page.goto("/admin/hour-log");
    await expect(
      page.getByRole("button", { name: "Log hours for a coach" }),
    ).toBeVisible();

    // ── COACH A ──────────────────────────────────────────────────────────
    await recordHours(page, {
      coachName: "E2E Coach Alpha",
      program: programName,
      typedDate: day.typed,
      start: "10:00",
      end: "15:00",
    });

    // 🔴 THE ASSERTION THE PRODUCTION FREEZE IS ABOUT. The dialog closing is
    // the ONLY signal the admin gets that a payable row was written. When it
    // stayed open over a blank form during the build, the row had already
    // been written and the screen was lying about the outcome — so this is
    // asserted on the dialog itself, not on the row appearing.
    await expect(page.locator("dialog[open]")).toBeHidden({ timeout: 15_000 });

    const afterA = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, programId));
    expect(afterA).toHaveLength(1);
    expect(afterA[0].coachId).toBe(coachAId);
    expect(afterA[0].createdBy).toBe(adminId);
    expect(afterA[0].status).toBe("posted");

    // ── COACH B, same program, same window ───────────────────────────────
    // The entry that froze in production. A second coach at an identical
    // window is not a double-pay — it is two people working one shift — so
    // it must go through with no warning and no stall.
    await recordHours(page, {
      coachName: "E2E Coach Bravo",
      program: programName,
      typedDate: day.typed,
      start: "10:00",
      end: "15:00",
    });

    await expect(page.locator("dialog[open]")).toBeHidden({ timeout: 15_000 });

    const afterB = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, programId));
    expect(afterB).toHaveLength(2);
    expect(new Set(afterB.map((r) => r.coachId))).toEqual(
      new Set([coachAId, coachBId]),
    );
    // Two separate payable rows, each priced on its own merits.
    expect(afterB.every((r) => r.ratePer30MinCents === 1500)).toBe(true);
  });

  // 🔴 THE AMBER DECISION → CONFIRM ROUND TRIP, which is the path Mark named
  // when he described the freeze ("after he pressed the confirm button").
  //
  // It is the only flow in the dialog that RE-RENDERS the form from a server
  // result and then submits it a second time, and it is where every moving
  // part meets: the `<form key>` remount that re-applies defaultValue, the
  // masked date field re-seeded from an ISO string, and a submit button whose
  // own name/value carries the confirmation. Nothing covered it.
  test("shows the warning, keeps the typed values, and records on confirm", async ({
    page,
  }) => {
    const day = pastDay(17);

    // A first entry to clash with. 10:00–15:00 for coach A…
    await page.goto("/admin/hour-log");
    await recordHours(page, {
      coachName: "E2E Coach Alpha",
      program: programName,
      typedDate: day.typed,
      start: "10:00",
      end: "15:00",
    });
    await expect(page.locator("dialog[open]")).toBeHidden({ timeout: 15_000 });

    // …then a PARTIAL overlap for the SAME coach: 10:00–14:00. The unique
    // index cannot see this one — it is the double-pay the warning exists
    // for — so the first submit must be refused with an amber decision.
    await recordHours(page, {
      coachName: "E2E Coach Alpha",
      program: programName,
      typedDate: day.typed,
      start: "10:00",
      end: "14:00",
    });

    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Before this is recorded")).toBeVisible({
      timeout: 15_000,
    });

    // Nothing was written by the refused submit.
    const afterRefusal = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, programId));
    expect(afterRefusal).toHaveLength(1);

    // 🔴 THE FORM MUST STILL HOLD WHAT THE ADMIN TYPED. React applies
    // defaultValue at MOUNT ONLY, and this result remounts the form — a
    // regression here renders the warning above an emptied form, leaving
    // nothing to confirm. Found in the build by looking, not by asserting.
    await expect(dialog.locator('select[name="coachId"]')).toHaveValue(
      coachAId,
    );
    await expect(dialog.locator('input[name="date"]')).toHaveValue(day.iso);
    await expect(dialog.locator('select[name="endTime"]')).toHaveValue("14:00");

    // Confirm. This is the click that froze.
    await dialog.getByRole("button", { name: "Record them anyway" }).click();
    await expect(page.locator("dialog[open]")).toBeHidden({ timeout: 15_000 });

    const afterConfirm = await db
      .select()
      .from(hourLogs)
      .where(eq(hourLogs.programId, programId));
    expect(afterConfirm).toHaveLength(2);
  });

  // The provenance line is the only thing on screen that distinguishes work
  // an admin typed in from work the coach logged. It had no coverage at all.
  test("shows 'Entered by' on a row the admin created", async ({ page }) => {
    const day = pastDay(19);

    await page.goto("/admin/hour-log");
    await recordHours(page, {
      coachName: "E2E Coach Alpha",
      program: programName,
      typedDate: day.typed,
      start: "09:00",
      end: "11:00",
    });
    await expect(page.locator("dialog[open]")).toBeHidden({ timeout: 15_000 });

    await expect(page.getByText(/Entered by/i).first()).toBeVisible();
  });
});
