/**
 * Capture real screenshots of the in-app coach SMS opt-in consent screen for
 * a public A2P 10DLC evidence page.
 *
 * Renders the first-login consent card from
 * src/app/coach/_components/sms-reminder-card.tsx (shown on /coach when the
 * coach's sms_prompt_answered_at is NULL): a "Finish setting up your account"
 * card with a phone field, an UNCHECKED consent checkbox (#sms-consent), the
 * full disclosure text, and Save / Not now buttons.
 *
 * Produces two PNGs in public/sms-evidence/:
 *   1. consent-card.png        — as first shown (empty phone + unchecked box)
 *   2. consent-card-filled.png — phone "(555) 555-0142" typed + box checked
 *
 * HARD GUARDRAIL: all DB writes go to the INTEGRATION branch only. Before any
 * write the script asserts INTEGRATION_DATABASE_URL's host contains
 * "dawn-forest" and ABORTS otherwise. It NEVER touches DATABASE_URL (prod,
 * ep-purple-credit).
 *
 * Auth uses the same cookie-injection pattern as tests/e2e/coach-flow.spec.ts:
 * a sessions row is inserted directly and its token set as the
 * authjs.session-token cookie.
 *
 * Run:  npx tsx scripts/sms-evidence/capture-screenshots.ts
 * Idempotent + re-runnable. Tears down the dev server and deletes the session
 * row it created on every exit path.
 */

import { config as loadDotenv } from "dotenv";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { neon } from "@neondatabase/serverless";

const ROOT = resolve(__dirname, "..", "..");
const OUT_DIR = resolve(ROOT, "public", "sms-evidence");
const PORT = 3001;
const BASE_URL = `http://localhost:${PORT}`;
const COACH_EMAIL = "sms-evidence@pfa.invalid";
const COACH_NAME = "Jordan Rivera";
const SAMPLE_PHONE = "(555) 555-0142";

// ── 1. Load env + guardrail ────────────────────────────────────────────────
loadDotenv({ path: resolve(ROOT, ".env.local") });

const INTEGRATION_URL = process.env.INTEGRATION_DATABASE_URL;
if (!INTEGRATION_URL) {
  console.error("ABORT: INTEGRATION_DATABASE_URL is not set in .env.local.");
  process.exit(1);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

const integrationHost = hostOf(INTEGRATION_URL);
if (!integrationHost.includes("dawn-forest")) {
  console.error(
    `ABORT (guardrail): INTEGRATION_DATABASE_URL host "${integrationHost}" ` +
      `does not contain "dawn-forest". Refusing to touch the database.`,
  );
  process.exit(1);
}
console.log(
  `[guardrail] OK — integration host "${integrationHost}" contains "dawn-forest".`,
);

// Extra belt-and-suspenders: make sure we are NOT pointed at prod.
if (integrationHost.includes("purple-credit")) {
  console.error("ABORT (guardrail): integration host looks like PROD. Refusing.");
  process.exit(1);
}

// ── lifecycle handles (for teardown on any exit path) ──────────────────────
let devServer: ChildProcess | null = null;
let browser: Browser | null = null;
let sql: ReturnType<typeof neon> | null = null;
let sessionToken: string | null = null;

async function teardown() {
  // Delete the session row we created; leave the user row (FK dependents).
  if (sql && sessionToken) {
    try {
      await sql`DELETE FROM sessions WHERE session_token = ${sessionToken}`;
      console.log("[cleanup] deleted session row.");
    } catch (err) {
      console.error("[cleanup] failed to delete session row:", err);
    }
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
  // neon HTTP driver is stateless — no pool to close.
  if (devServer && !devServer.killed) {
    devServer.kill("SIGTERM");
    // Give it a moment, then force-kill.
    await new Promise((r) => setTimeout(r, 1500));
    if (!devServer.killed) {
      try {
        devServer.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    console.log("[cleanup] dev server torn down.");
  }
}

async function waitForServer(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      // Any HTTP response (200 / 3xx redirect to sign-in) means it's up.
      if (res.status > 0) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Dev server did not respond at ${url} within ${timeoutMs}ms.`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  // ── 3. Upsert the demo coach (integration DB only) ──────────────────────
  // neon() returns a tagged-template fn that runs over HTTP against the
  // integration branch. Stateless: no pool, no .end().
  sql = neon(INTEGRATION_URL!);

  // Upsert by email; force the first-login consent state. `users.id` is
  // generated app-side in Drizzle ($defaultFn), so raw SQL supplies one for
  // the insert path; on conflict the existing id is kept.
  const newUserId = randomUUID();
  const coachRows = (await sql`
    INSERT INTO users (id, email, name, role, sms_opt_in, sms_prompt_answered_at, phone)
    VALUES (${newUserId}, ${COACH_EMAIL}, ${COACH_NAME}, 'coach', false, NULL, NULL)
    ON CONFLICT (email) DO UPDATE SET
      name = EXCLUDED.name,
      role = 'coach',
      sms_opt_in = false,
      sms_prompt_answered_at = NULL,
      phone = NULL
    RETURNING id
  `) as { id: string }[];
  const coach = coachRows[0];
  if (!coach?.id) throw new Error("Failed to upsert demo coach user.");
  const coachId: string = coach.id;
  console.log(`[db] demo coach ready (id=${coachId}, prompt state reset).`);

  sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await sql`
    INSERT INTO sessions (session_token, user_id, expires)
    VALUES (${sessionToken}, ${coachId}, ${expires})
  `;
  console.log("[db] session row inserted.");

  // ── 2. Boot dev server with integration DB ──────────────────────────────
  console.log("[server] starting next dev on port 3001 (integration DB)…");
  devServer = spawn("npx", ["next", "dev", "-p", String(PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: INTEGRATION_URL,
      AUTH_URL: BASE_URL,
      AUTH_SECRET:
        process.env.AUTH_SECRET ?? "sms-evidence-secret-not-used-in-production",
      AUTH_GOOGLE_ID:
        process.env.AUTH_GOOGLE_ID ??
        "evidence-placeholder.apps.googleusercontent.com",
      AUTH_GOOGLE_SECRET:
        process.env.AUTH_GOOGLE_SECRET ?? "evidence-placeholder-secret",
      AUTH_RESEND_KEY: process.env.AUTH_RESEND_KEY ?? "re_evidence_placeholder",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  devServer.on("error", (err) => {
    console.error("[server] spawn error:", err);
  });

  await waitForServer(BASE_URL, 90_000);
  console.log("[server] up.");

  // ── 4. Browser + cookie injection ───────────────────────────────────────
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 2,
  });
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

  const page = await context.newPage();

  // ── 5. Navigate to /coach and wait for the consent card ─────────────────
  await page.goto(`${BASE_URL}/coach`, { waitUntil: "networkidle" });

  const section = page.locator('section[aria-labelledby="sms-setup-heading"]');
  await section
    .getByRole("heading", { name: "Finish setting up your account" })
    .or(page.locator("#sms-consent"))
    .first()
    .waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("#sms-consent").waitFor({ state: "visible", timeout: 20_000 });

  // Small settle for fonts/gradient paint.
  await page.waitForTimeout(400);

  // ── 6. Screenshot #1: consent card as first shown ───────────────────────
  const shot1 = resolve(OUT_DIR, "consent-card.png");
  await section.screenshot({ path: shot1 });
  console.log(`[shot] consent-card.png written.`);

  // ── 7. Fill phone + check the consent box, then screenshot #2 ───────────
  await page.fill('input[name="phone"]', SAMPLE_PHONE);
  await page.check("#sms-consent");
  await page.waitForTimeout(300);

  const shot2 = resolve(OUT_DIR, "consent-card-filled.png");
  await section.screenshot({ path: shot2 });
  console.log(`[shot] consent-card-filled.png written.`);

  // ── verify on the way out ───────────────────────────────────────────────
  for (const p of [shot1, shot2]) {
    const { size } = statSync(p);
    const kb = (size / 1024).toFixed(1);
    console.log(`[verify] ${p} — ${kb} KB`);
    if (size < 30 * 1024) {
      console.warn(`[verify] WARNING: ${p} is under 30KB (${kb} KB).`);
    }
  }
}

main()
  .then(async () => {
    await teardown();
    console.log("[done] screenshots captured successfully.");
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[error]", err);
    await teardown();
    process.exit(1);
  });

// Make sure a stray Ctrl-C still tears things down.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await teardown();
    process.exit(130);
  });
}
