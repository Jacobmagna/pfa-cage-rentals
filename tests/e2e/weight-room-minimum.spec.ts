// E2E: the weight room one-hour minimum on the coach calendar.
//
//   1. One tap on a free weight room slot books ONE 60-minute rental.
//   2. "Select multiple slots" with one lone weight room slot: the panel
//      refuses it up front and the Book button is disabled, so nothing is
//      sent.
//   3. Two back-to-back weight room slots book as ONE rental, and the
//      confirmation counts that one rental.
//
// Same sign-in and clean-slate pattern as coach-flow.spec.ts: an injected
// Auth.js session cookie, and sessions_billing / blocked_times / audit_log
// truncated before each test. Every booking is TOMORROW at 3:00 PM so it is
// in the future and the day starts empty.

import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db";
import {
  resources,
  sessions as authSessions,
  sessionsBilling,
  users,
} from "../../src/db/schema";

const COACH_EMAIL = "e2e-weight-room-coach@pfa.invalid";

let coachId: string;
let sessionToken: string;
let weightRoom1Id: string;

test.beforeAll(async () => {
  await db
    .insert(users)
    .values({ email: COACH_EMAIL, name: "E2E Weight Room Coach", role: "coach" })
    .onConflictDoUpdate({
      target: users.email,
      set: { role: "coach", name: "E2E Weight Room Coach" },
    });
  const [coach] = await db
    .select()
    .from(users)
    .where(eq(users.email, COACH_EMAIL))
    .limit(1);
  if (!coach) throw new Error("Failed to upsert E2E weight room coach");
  coachId = coach.id;

  const [wr1] = await db
    .select()
    .from(resources)
    .where(eq(resources.name, "Weight Room 1"))
    .limit(1);
  if (!wr1) {
    throw new Error(
      "Weight Room 1 not seeded on the integration branch. Run " +
        "`DATABASE_URL=$INTEGRATION_DATABASE_URL npm run db:seed`.",
    );
  }
  weightRoom1Id = wr1.id;

  sessionToken = randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    sessionToken,
    userId: coachId,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
});

test.afterAll(async () => {
  await db
    .delete(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken));
});

test.beforeEach(async ({ context }) => {
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

async function coachRentals() {
  return db
    .select({
      resourceId: sessionsBilling.resourceId,
      startAt: sessionsBilling.startAt,
      endAt: sessionsBilling.endAt,
    })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.coachId, coachId));
}

const minutes = (r: { startAt: Date; endAt: Date }) =>
  (r.endAt.getTime() - r.startAt.getTime()) / 60_000;

async function openTomorrow(page: import("@playwright/test").Page) {
  await page.goto("/coach/sessions/new");
  await expect(page.getByRole("heading", { name: "New rental" })).toBeVisible();
  await page.getByRole("button", { name: "Next day" }).click();
}

test("one tap on a free weight room slot books one 60-minute rental", async ({
  page,
}) => {
  await openTomorrow(page);
  await page
    .getByRole("button", { name: "Book Weight Room 1 at 3:00 PM" })
    .click();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();

  // The panel opens at one hour, with no 30-minute choice.
  await expect(page.getByText("3:00 PM – 4:00 PM", { exact: true })).toBeVisible();
  const duration = page.getByRole("group", { name: "Rental duration" });
  await expect(duration.getByRole("button", { name: "1 hr" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(duration.getByRole("button", { name: "30 min" })).toHaveCount(0);

  await page.getByRole("button", { name: "Book this slot" }).click();
  await expect(
    page.getByText("Rental logged. The slot is now yours (gold)."),
  ).toBeVisible();

  const rows = await coachRentals();
  expect(rows).toHaveLength(1);
  expect(rows[0].resourceId).toBe(weightRoom1Id);
  expect(minutes(rows[0])).toBe(60);
});

test("select multiple: a lone weight room slot is refused and Book is disabled", async ({
  page,
}) => {
  await openTomorrow(page);
  await page.getByRole("button", { name: "Select multiple slots" }).click();
  await page
    .getByRole("button", { name: "Book Weight Room 1 at 3:00 PM" })
    .click();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();

  const refusal = page
    .getByRole("alert")
    .filter({ hasText: "Weight room rentals are one hour minimum." });
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText(
    "3:00 PM on Weight Room 1 is a single half hour. Add 2:30 PM or 3:30 PM too, or remove it.",
  );
  await expect(page.getByRole("button", { name: "Book 1 rental" })).toBeDisabled();

  expect(await coachRentals()).toHaveLength(0);
});

test("select multiple: two back-to-back weight room slots book as one rental", async ({
  page,
}) => {
  await openTomorrow(page);
  await page.getByRole("button", { name: "Select multiple slots" }).click();
  await page
    .getByRole("button", { name: "Book Weight Room 1 at 3:00 PM" })
    .click();
  await page
    .getByRole("button", { name: "Book Weight Room 1 at 3:30 PM" })
    .click();
  await page.getByRole("button", { name: "Schedule", exact: true }).click();

  await expect(
    page.getByText("3:00 PM – 4:00 PM (1 hr)", { exact: true }),
  ).toBeVisible();
  const book = page.getByRole("button", { name: "Book 1 rental" });
  await expect(book).toBeEnabled();
  await book.click();

  await expect(
    page.getByText("1 rental logged. Those slots are now yours (gold)."),
  ).toBeVisible();

  const rows = await coachRentals();
  expect(rows).toHaveLength(1);
  expect(rows[0].resourceId).toBe(weightRoom1Id);
  expect(minutes(rows[0])).toBe(60);
});
