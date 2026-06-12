// E2E happy path for the coach flow: sign in (via injected cookie),
// log a cage rental at /coach/sessions/new, see it on /coach/sessions,
// delete it, see the empty state again.
//
// This is the highest-value automated test in the suite — it
// exercises auth → middleware → server component → client hydration
// → useActionState → server action → DB → revalidatePath → re-render.
// Any of those seams breaking shows up here.
//
// The booking surface was reflowed: the Calendly-style calendar is now
// the DEFAULT view, with the legacy form behind a "Prefer the form?"
// toggle. The form defaults to a 1-hour range at 30-min slots (a 2-slot
// BATCH); selecting the "1 hr" slot length collapses that to a single
// 1-hour rental (one history row + a visible Note field). The coach
// history surface deliberately renders NO dollar amounts (money is
// admin-only), so the $44 rate is asserted against the persisted
// billing snapshot rather than a UI string.
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
  sessionsBilling,
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

test("coach logs a rental, sees it in history, then deletes it", async ({
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

  // 1. Open the booking page — the calendar is the default surface.
  await page.goto("/coach/sessions/new");
  await expect(
    page.getByRole("heading", { name: "New rental" }),
  ).toBeVisible();

  // 2. Reveal the form (calendar → form toggle).
  await page.getByRole("button", { name: "Prefer the form?" }).click();

  // 3. The form defaults to a 1-hr range at 30-min slots = a 2-slot
  // batch (Note hidden, submit reads "Log 2 rentals"). Click the
  // "1 hr" slot length so it collapses to a SINGLE 1-hour rental:
  // one history row + the Note field appears + submit reads exactly
  // "Log rental".
  await page.getByRole("radio", { name: "1 hr" }).click();

  // 4. Push the rental into the FUTURE so its history row is deletable.
  // A coach can only request removal of a PAST rental (startAt <= now),
  // and the form defaults to the current half-hour (which reads as past).
  // The DateInput's visible field is a masked MM/DD/YYYY text input; the
  // hidden input[name=date] carries the resolved ISO. Type tomorrow.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getDate()).padStart(2, "0");
  const yyyy = String(tomorrow.getFullYear());
  await page
    .getByRole("textbox", { name: "Date" })
    .or(page.locator('input[placeholder="MM/DD/YYYY"]'))
    .first()
    .fill(`${mm}/${dd}/${yyyy}`);

  // 5. Pick the cage, 6. fill the note, 7. submit.
  await page
    .locator("select[name=resourceId]")
    .selectOption({ label: "Cage 5" });
  await page.locator("input[name=note]").fill("E2E happy path");
  await page.getByRole("button", { name: "Log rental", exact: true }).click();

  // 8. Success: the form collapses into a CompletionPanel (role=status).
  await expect(page.getByRole("status")).toContainText("Rental logged");

  // 9. Navigate to history.
  await page.goto("/coach/sessions");
  await expect(
    page.getByRole("heading", { name: "My rentals" }),
  ).toBeVisible();

  // 10. See the row. Filter by resource + note to disambiguate.
  const row = page
    .locator("ul > li")
    .filter({ hasText: "Cage 5" })
    .filter({ hasText: "E2E happy path" });
  await expect(row).toBeVisible();
  // The UI row proves it's a SINGLE 1-hour rental (the "1 hr" duration
  // chip) — the coach surface shows no money.
  await expect(row).toContainText("1 hr");
  // Rate math sanity, asserted at the data layer since the coach surface
  // renders no dollars: a 1-hour cage rental snapshots a $22.00/30-min
  // rate, so the persisted billing row totals 2 × 2200 = 4400¢ = $44.00.
  const [billed] = await db
    .select({ rate: sessionsBilling.ratePer30MinCents })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.coachId, coachId))
    .limit(1);
  if (!billed) throw new Error("Logged rental not found in sessions_billing");
  expect(billed.rate * 2).toBe(4400);

  // 11. Delete it. The destructive confirm is a custom <ConfirmDialog>
  // (no native window.confirm), so we click the row's "Delete rental"
  // (aria-label) button, then the dialog's "Delete rental" confirm
  // button. The dialog handler below is a harmless backstop in case any
  // surface still routes through the native prompt.
  page.once("dialog", (dialog) => dialog.accept());
  await row.getByRole("button", { name: "Delete rental" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete rental" })
    .click();

  // 12. Row gone, empty state appears (the "No rentals yet" <h2> only
  // renders once this coach has zero lifetime rentals).
  await expect(row).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No rentals yet" }),
  ).toBeVisible();
});
