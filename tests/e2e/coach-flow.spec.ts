// E2E happy path for the coach flow: sign in (via injected cookie),
// log a session at /coach/sessions/new, see it on /coach/sessions,
// delete it, see the empty state again.
//
// This is the highest-value automated test in the suite — it
// exercises auth → middleware → server component → client hydration
// → useActionState → server action → DB → revalidatePath → re-render.
// Any of those seams breaking shows up here.
//
// Resist adding error-path tests in this file — those live in the
// Vitest integration suite (tests/integration/) which doesn't need a
// browser. E2E is for golden flows only.

import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db";
import {
  resources,
  sessions as authSessions,
  users,
} from "../../src/db/schema";

const COACH_EMAIL = "e2e-coach@pfa.invalid";

let coachId: string;
let sessionToken: string;

test.beforeAll(async () => {
  // Upsert the test coach. Idempotent — we don't tear down the user
  // between runs because Auth.js's `users` table has foreign-key
  // dependents (audit_log rows from past test runs, etc.) and we
  // care about the session-token cookie, not the user row.
  await db
    .insert(users)
    .values({ email: COACH_EMAIL, name: "E2E Coach", role: "coach" })
    .onConflictDoUpdate({
      target: users.email,
      set: { role: "coach", name: "E2E Coach" },
    });
  const [coach] = await db
    .select()
    .from(users)
    .where(eq(users.email, COACH_EMAIL))
    .limit(1);
  if (!coach) throw new Error("Failed to upsert E2E coach user");
  coachId = coach.id;

  sessionToken = randomBytes(32).toString("hex");
  await db.insert(authSessions).values({
    sessionToken,
    userId: coachId,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
});

test.afterAll(async () => {
  // Drop our auth cookie row — leave the user + any historical audit
  // rows in place so we don't fight with the integration suite over
  // the same DB.
  await db
    .delete(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken));
});

test.beforeEach(async ({ context }) => {
  // Fresh slate per test. Same scope as the integration suite —
  // sessions_billing, blocked_times, audit_log. The seeded resources
  // + rate defaults + our coach user all survive.
  await db.execute(
    sql`TRUNCATE TABLE sessions_billing, blocked_times, audit_log RESTART IDENTITY CASCADE`,
  );

  // Inject the Auth.js session-token cookie. domain:"localhost" is
  // port-agnostic in browsers, so port 3001 works.
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

test("coach logs a session, sees it in history, then deletes it", async ({
  page,
}) => {
  // Sanity check: Cage 5 must be seeded. If this fails the test
  // gives a clear message instead of a mysterious dropdown miss.
  const [cage5] = await db
    .select()
    .from(resources)
    .where(eq(resources.name, "Cage 5"))
    .limit(1);
  if (!cage5) {
    throw new Error(
      "Cage 5 not seeded on the integration branch. Run " +
        "`DATABASE_URL=$INTEGRATION_DATABASE_URL npm run db:seed`.",
    );
  }

  // 1. Log the session.
  await page.goto("/coach/sessions/new");
  await expect(page.getByRole("heading", { name: "New session" })).toBeVisible();

  await page.locator("select[name=resourceId]").selectOption({ label: "Cage 5" });
  await page.locator("input[name=note]").fill("E2E happy path");

  await page.getByRole("button", { name: "Log session" }).click();

  // 2. Success banner appears (and form clears, but we only assert
  // the banner — clearing is covered by D1 manual verification).
  await expect(page.getByRole("status")).toContainText("Session logged");

  // 3. Navigate to history.
  await page.goto("/coach/sessions");
  await expect(page.getByRole("heading", { name: "My sessions" })).toBeVisible();

  // 4. See the row. Filter by resource + note to disambiguate.
  const row = page
    .locator("ul > li")
    .filter({ hasText: "Cage 5" })
    .filter({ hasText: "E2E happy path" });
  await expect(row).toBeVisible();
  // Rate math sanity: 1-hour cage session = 2 × $22.00 = $44.00.
  await expect(row).toContainText("$44.00");

  // 5. Delete it. The client uses native confirm(); Playwright's
  // dialog handler auto-accepts the next prompt.
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Delete session" }).click();

  // 6. Row gone, empty state appears.
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No sessions yet")).toBeVisible();
});
