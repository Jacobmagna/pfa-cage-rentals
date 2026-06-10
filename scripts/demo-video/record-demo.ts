// Demo-video recorder. Drives the LIVE app (booted by run.sh on :3001
// against the integration branch) with Playwright's chromium API
// directly — NOT the test runner — so we can use one browser context
// per segment, each with its own recordVideo.dir, and get a separate
// .webm file per tab/feature.
//
// Auth = cookie injection (the e2e pattern): we upsert demo users, mint
// a DB session token per role, and set the authjs.session-token cookie
// in that role's context. Two contexts: admin + coach. Session-token
// rows are cleaned up at the end (users are left — FK dependents).
//
// Captions: NO LONGER baked into the recordings. We record CLEAN app
// screens (only the app UI) and persist a caption MANIFEST
// (segments/captions.json) mapping each segment slug → { leadIn, text }.
// post-process.ts composites a single CONSTANT bottom bar + per-section
// text ON TOP of the xfaded screen track, so the bar never dims during a
// crossfade. The old in-page #__demo_caption__ overlay is gone.
//
// REVEAL MODEL (rewritten 2026-06): there is NO body-hide style, NO
// full-screen cover, and NO skeleton-guard re-hide loop. We NEVER hide
// the body. Instead, per segment we navigate, wait for networkidle, wait
// for a CONCRETE content anchor to be visible AND for the loading
// skeleton (.animate-pulse) to be gone, settle, set the caption, and
// dwell over the live populated UI. Any brief opening flash is removed
// deterministically in post-process by trimming the first ~1s of each
// FEATURE segment (cards are not trimmed). This guarantees the recorded
// dwell is the real, populated UI — the caption simply sits over it.
//
// Output: raw .webm per segment → scripts/demo-video/segments/NN-slug.webm.
// ffmpeg post-process (separate step) normalizes + concatenates.

import { chromium, type BrowserContext, type Page } from "playwright";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { demoDb } from "./db";
import { programs, sessions as authSessions, users } from "../../src/db/schema";
import { formatPfaDate } from "../../src/lib/timezone";

const BASE_URL = process.env.DEMO_BASE_URL ?? "http://localhost:3001";
const VIEWPORT = { width: 1920, height: 1080 };
const SEGMENTS_DIR = path.resolve(__dirname, "segments");
const SLOW_MO = 120;

// Every route the tour visits. We WARM these in a throwaway context before
// recording so Next's dev-server on-demand compilation (which leaves the
// first visit blank for many seconds) is already done — recordings then
// show content immediately.
const WARMUP_ROUTES = [
  "/admin",
  "/admin/schedule",
  "/admin/hour-log",
  "/admin/attendance/by-program",
  "/admin/attendance/by-player",
  "/admin/attendance/roster",
  "/admin/reports",
  "/admin/payments",
  "/admin/records",
  "/admin/audit",
  "/coach/sessions/new",
  "/coach/hour-log",
  "/coach/attendance",
  "/coach/schedule",
  "/coach",
];

const BRAND_YELLOW = "#FFC400";
const BRAND_BLACK = "#0a0a0a";

const DEMO_ADMIN_EMAIL = "demo-admin@pfa.invalid";
const DEMO_COACH_EMAIL = "demo-coach@pfa.invalid";

// ---------------------------------------------------------------------------
// Caption MANIFEST — the recordings are now CLEAN (no baked bar). Each
// segment's caption metadata is persisted to segments/captions.json so the
// post step can composite a constant bar + windowed text on top of the
// xfaded screen track.
// ---------------------------------------------------------------------------
interface CaptionEntry {
  leadIn: string;
  text: string;
}
// slug (NN-slug, no extension) → caption metadata, in recorded order.
const captionManifest: Record<string, CaptionEntry> = {};
// The slug of the segment currently being recorded; set by recordSegment.
let currentSlug: string | null = null;

// Record this segment's caption metadata into the manifest. NOTHING is
// rendered into the page anymore — the recordings stay clean and the bar +
// text are drawn in post-process.
function setCaption(text: string, leadIn?: string) {
  if (currentSlug) {
    captionManifest[currentSlug] = { leadIn: leadIn ?? "", text };
  }
}

// No-op kept so the scroll path doesn't need to change: there is no in-page
// caption to re-pin anymore (the bar is composited in post).
function raiseCaption() {
  /* clean recordings — nothing to re-assert */
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait for the app nav bar to be present — a sticky <header> containing the
// "PFA Engine" logo image. A MISSING nav means the context is not
// authenticated (or wrong role); we surface that loudly so the segment is
// never recorded blank.
async function waitForNav(page: Page, label: string) {
  const ok = await page
    .locator('header img[alt="PFA Engine"]')
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    console.warn(
      `[rec] WARNING: nav bar not visible on ${label} — context may be ` +
        `unauthenticated or wrong role.`,
    );
  }
  return ok;
}

// Wait for the route's loading skeleton to be fully gone: no Tailwind
// .animate-pulse element remains. Bounded so a flaky page never stalls.
async function waitForNoSkeleton(page: Page) {
  await page
    .waitForFunction(
      () => document.querySelectorAll(".animate-pulse").length === 0,
      undefined,
      { timeout: 15_000, polling: 150 },
    )
    .catch(() => {});
}

// Wait for a CONCRETE content anchor to be visible on the page. `anchors`
// is a list of candidate locators; we RACE them and proceed the instant the
// FIRST one becomes visible (a populated page satisfies one quickly). Only if
// NONE appear within the timeout do we wait the full window and then warn.
// Using a race (not Promise.all) is what keeps segment durations tight — an
// all-settle wait would block on every non-matching anchor's full timeout.
async function waitForAnchor(
  page: Page,
  anchors: Array<import("playwright").Locator>,
  label: string,
) {
  if (anchors.length === 0) return;
  const firstHit = new Promise<boolean>((resolve) => {
    let pending = anchors.length;
    for (const loc of anchors) {
      loc
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .then(() => resolve(true)) // first visible anchor wins immediately
        .catch(() => {
          // resolve(false) only once ALL anchors have failed
          if (--pending === 0) resolve(false);
        });
    }
  });
  const ok = await firstHit;
  if (!ok) {
    console.warn(`[rec] WARNING: no content anchor visible on ${label}.`);
  }
}

// ---------------------------------------------------------------------------
// Navigate + reveal: the simple, robust per-segment flow (no cover, no
// body-hide). goto(domcontentloaded) → networkidle → nav visible → content
// anchor visible → skeleton gone → settle → set caption → (caller dwells).
// ---------------------------------------------------------------------------
async function show(
  page: Page,
  route: string,
  opts: {
    anchors?: (page: Page) => Array<import("playwright").Locator>;
    caption: string;
    leadIn?: string;
    settleMs?: number;
  },
) {
  try {
    await page.goto(`${BASE_URL}${route}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
  } catch (e) {
    console.warn(
      `[rec] goto ${route} slow/failed: ${(e as Error).message.slice(0, 80)}`,
    );
  }
  // Short networkidle wait only: the Next dev server keeps an HMR websocket
  // open, so the page rarely reaches a true "idle" — a long timeout here just
  // burns ~20s of recorded wall-clock per segment (the duration-bloat bug).
  // The nav + content-anchor + no-skeleton waits below are what actually
  // gate on populated UI, so a brief idle attempt is enough.
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  // Nav bar must render (authenticated) before we trust the page.
  await waitForNav(page, route);
  // Wait for a concrete, content-specific anchor (real data, not a skeleton).
  if (opts.anchors) await waitForAnchor(page, opts.anchors(page), route);
  // And assert the route loading skeleton is fully gone.
  await waitForNoSkeleton(page);
  // Settle: let fonts/layout paint.
  await sleep(opts.settleMs ?? 800);
  // Record this segment's caption metadata (composited in post).
  setCaption(opts.caption, opts.leadIn);
}

async function gentleScroll(page: Page, dy: number) {
  await page.mouse.wheel(0, dy);
  raiseCaption();
  await sleep(700);
  raiseCaption();
}

// ---------------------------------------------------------------------------
// Context factory — one per segment, own recordVideo.dir.
// ---------------------------------------------------------------------------
type RoleCookie = { sessionToken: string };

async function newSegmentContext(
  browser: import("playwright").Browser,
  cookie: RoleCookie,
  videoDir: string,
): Promise<BrowserContext> {
  mkdirSync(videoDir, { recursive: true });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: videoDir, size: VIEWPORT },
    deviceScaleFactor: 1,
  });
  await ctx.addCookies([
    {
      name: "authjs.session-token",
      value: cookie.sessionToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  // NO in-page caption overlay anymore. The recordings capture ONLY the app
  // UI (clean screens). The constant bottom bar + per-section text are
  // composited in post-process.ts as a top layer drawn after the screen
  // xfade, so the bar can never dim during a crossfade.
  return ctx;
}

// Close the context, then move its single produced .webm to the named file.
async function finishSegment(
  ctx: BrowserContext,
  page: Page,
  videoDir: string,
  outName: string,
) {
  const video = page.video();
  await ctx.close();
  // Playwright finalizes the .webm on context close.
  let produced: string | undefined;
  if (video) {
    produced = await video.path().catch(() => undefined);
  }
  if (!produced) {
    const files = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
    if (files.length > 0) produced = path.join(videoDir, files[0]);
  }
  if (!produced || !existsSync(produced)) {
    throw new Error(`No .webm produced for segment ${outName}`);
  }
  const dest = path.join(SEGMENTS_DIR, outName);
  renameSync(produced, dest);
  console.log(`[rec] wrote ${outName}`);
}

// ---------------------------------------------------------------------------
// Brand cards (intro / outro).
// ---------------------------------------------------------------------------
function cardHtml(opts: {
  logo?: boolean;
  title: string;
  subtitle?: string;
  footer?: string;
}): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:${BRAND_BLACK};overflow:hidden}
    .wrap{height:100vh;display:flex;flex-direction:column;align-items:center;
      justify-content:center;gap:36px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      text-align:center;padding:0 8vw}
    img{width:520px;height:auto}
    h1{color:${BRAND_YELLOW};font-size:58px;font-weight:800;margin:0;line-height:1.15;max-width:18ch}
    .sub{color:rgba(255,255,255,0.82);font-size:30px;font-weight:500;margin:0;max-width:24ch}
    .foot{color:rgba(255,255,255,0.5);font-size:22px;font-weight:600;letter-spacing:0.12em;margin-top:18px}
    .rule{width:120px;height:4px;background:${BRAND_YELLOW};border-radius:2px}
  </style></head><body><div class="wrap">
    ${opts.logo ? `<img src="${BASE_URL}/pfa-engine-logo.png" alt="PFA Engine"/>` : ""}
    <div class="rule"></div>
    <h1>${opts.title}</h1>
    ${opts.subtitle ? `<p class="sub">${opts.subtitle}</p>` : ""}
    ${opts.footer ? `<div class="foot">${opts.footer}</div>` : ""}
  </div></body></html>`;
}

async function recordCard(
  browser: import("playwright").Browser,
  cookie: RoleCookie,
  outName: string,
  html: string,
  holdMs: number,
) {
  const videoDir = path.join(SEGMENTS_DIR, `_tmp_${outName}`);
  const ctx = await newSegmentContext(browser, cookie, videoDir);
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  // wait for the logo image to actually load if present
  await page
    .locator("img")
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => {});
  // Cards supply their own full-screen black background; there is no caption,
  // cover, or body-hide to remove. Keep the recording "active" across the
  // hold with periodic micro-repaints — Playwright's recordVideo
  // under-captures a fully-static page (which can yield a ~1s clip even
  // though we hold for holdMs). A transform nudge every ~300ms forces frames
  // without any visible change.
  const ticks = Math.max(1, Math.round(holdMs / 300));
  for (let t = 0; t < ticks; t++) {
    await page
      .evaluate((n) => {
        const b = document.body;
        if (b) b.style.transform = n % 2 ? "translateZ(0)" : "none";
      }, t)
      .catch(() => {});
    await sleep(300);
  }
  await finishSegment(ctx, page, videoDir, outName);
  rmSync(videoDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A single live-app segment.
// ---------------------------------------------------------------------------
async function recordSegment(
  browser: import("playwright").Browser,
  cookie: RoleCookie,
  outName: string,
  fn: (page: Page) => Promise<void>,
) {
  currentSlug = outName.replace(/\.webm$/, "");
  const videoDir = path.join(SEGMENTS_DIR, `_tmp_${outName}`);
  const ctx = await newSegmentContext(browser, cookie, videoDir);
  const page = await ctx.newPage();
  await fn(page);
  await finishSegment(ctx, page, videoDir, outName);
  rmSync(videoDir, { recursive: true, force: true });
  currentSlug = null;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  const db = demoDb();

  // Clean segments dir of stale webm/tmp so the rerun is clean.
  mkdirSync(SEGMENTS_DIR, { recursive: true });
  for (const f of readdirSync(SEGMENTS_DIR)) {
    rmSync(path.join(SEGMENTS_DIR, f), { recursive: true, force: true });
  }

  // Resolve demo users (seed-demo-data upserted them).
  const adminUser = (
    await db.select().from(users).where(eq(users.email, DEMO_ADMIN_EMAIL)).limit(1)
  )[0];
  const coachUser = (
    await db.select().from(users).where(eq(users.email, DEMO_COACH_EMAIL)).limit(1)
  )[0];
  if (!adminUser || !coachUser) {
    throw new Error(
      "Demo users not found — run seed-demo-data.ts first (it upserts them).",
    );
  }

  // Mint a session token per role.
  const adminToken = randomBytes(32).toString("hex");
  const coachToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db.insert(authSessions).values([
    { sessionToken: adminToken, userId: adminUser.id, expires },
    { sessionToken: coachToken, userId: coachUser.id, expires },
  ]);

  const admin: RoleCookie = { sessionToken: adminToken };
  const coach: RoleCookie = { sessionToken: coachToken };
  const ADMIN_LEAD = "The owner's side —";
  const COACH_LEAD = "And what your coaches see —";

  // /coach/attendance only renders the athlete-checkbox roster when given a
  // ?programId=&date= for a program with enrolled athletes (DEC-29). Resolve
  // a populated program ("HS Summer Program" — seeded + enrolled by
  // seed-demo-data) so the coach attendance segment shows a real roster.
  const attnProgram =
    (
      await db
        .select({ id: programs.id })
        .from(programs)
        .where(eq(programs.name, "HS Summer Program"))
        .limit(1)
    )[0] ??
    (await db.select({ id: programs.id }).from(programs).limit(1))[0];
  const attnDate = formatPfaDate(new Date());
  const coachAttendanceRoute = attnProgram
    ? `/coach/attendance?programId=${attnProgram.id}&date=${attnDate}`
    : "/coach/attendance";
  // /admin/attendance/by-program also needs a ?programId= to render the
  // per-program athlete grid (otherwise it shows "Pick work to view
  // attendance"). Reuse the same populated program.
  const adminByProgramRoute = attnProgram
    ? `/admin/attendance/by-program?programId=${attnProgram.id}`
    : "/admin/attendance/by-program";

  const browser = await chromium.launch({ slowMo: SLOW_MO });

  // Warm up every route (compile Next dev routes) in a throwaway,
  // NON-recording admin+coach context so the first real recording of each
  // page shows content immediately instead of a multi-second blank compile.
  console.log("[rec] warming up routes (dev compile)…");
  for (const token of [adminToken, coachToken]) {
    const warmCtx = await browser.newContext({ viewport: VIEWPORT });
    await warmCtx.addCookies([
      {
        name: "authjs.session-token",
        value: token,
        domain: "localhost",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const warmPage = await warmCtx.newPage();
    // admin token warms /admin routes; coach token warms /coach routes.
    const isAdmin = token === adminToken;
    const routes = WARMUP_ROUTES.filter((r) =>
      isAdmin ? r.startsWith("/admin") : r.startsWith("/coach"),
    );
    // Also warm the PARAM'd attendance routes the tour actually records, so
    // the first real recording hits a fully-compiled param render (the bare
    // route compiles a different code path than the program-selected one).
    if (isAdmin) routes.push(adminByProgramRoute);
    else routes.push(coachAttendanceRoute);
    for (const route of routes) {
      try {
        await warmPage.goto(`${BASE_URL}${route}`, {
          waitUntil: "networkidle",
          timeout: 60_000,
        });
        await warmPage
          .waitForFunction(
            () => document.querySelectorAll(".animate-pulse").length === 0,
            undefined,
            { timeout: 20_000, polling: 200 },
          )
          .catch(() => {});
      } catch (e) {
        console.warn(`[rec] warmup ${route}: ${(e as Error).message.slice(0, 80)}`);
      }
    }
    await warmCtx.close();
  }
  console.log("[rec] warmup done.");

  try {
    // 00 — intro card
    await recordCard(
      browser,
      admin,
      "00-intro.webm",
      cardHtml({
        logo: true,
        title: "One platform for everything a facility runs on.",
      }),
      3000,
    );

    // 01 — Master Schedule at top of Home. Anchor: nav + a resource row
    // label ("Cage 1") and at least one schedule block bar in the grid.
    await recordSegment(browser, admin, "01-home-schedule.webm", async (page) => {
      await show(page, "/admin", {
        anchors: (p) => [
          p.getByText("Cage 1", { exact: false }),
          p.getByRole("heading", { name: "Home", exact: false }),
        ],
        caption:
          "Your whole facility's day on one schedule — drag to book, click to edit.",
        leadIn: ADMIN_LEAD,
      });
      // Dwell raised so the normalized (post-1s-trim) duration is ≥ ~5.6s,
      // i.e. caption window (normDur − XFADE 0.4) ≥ ~5.2s — clears the 5s floor.
      await sleep(2400);
      await gentleScroll(page, 350);
      await sleep(2400);
    });

    // 02 — Home: scroll to Needs review + Recent activity.
    await recordSegment(browser, admin, "02-home-needs-review.webm", async (page) => {
      await show(page, "/admin", {
        anchors: (p) => [
          p.getByText("Needs review", { exact: false }),
          p.getByText("Recent activity", { exact: false }),
          p.getByRole("heading", { name: "Home", exact: false }),
        ],
        caption:
          "It flags what needs attention — no-shows, unlogged hours, cancellations.",
        leadIn: ADMIN_LEAD,
      });
      // The /admin Home loads scrolled-to-top showing the Master Schedule
      // first. Scroll DOWN to the Needs-review/stat-cards band and frame it,
      // then SETTLE so the band is steady (not mid-scroll) before the hold.
      // We bring the Needs-review card into view rather than guessing a pixel
      // offset (the master schedule's height varies with seeded blocks).
      await page
        .getByText("Needs review", { exact: false })
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      // Nudge up slightly so the stat cards above the Needs-review card are
      // also in frame (scrollIntoView pins the target to the top edge).
      await page.mouse.wheel(0, -180);
      await sleep(900); // settle the framed top-of-dashboard view
      // HOLD on the alerts/stat-cards band with NO scroll — long enough to
      // read the Needs-review alerts (~3.5s).
      await sleep(3500);
      // THEN gentle-scroll down to the Recent Activity feed and pause there.
      await gentleScroll(page, 700);
      await sleep(2000);
    });

    // 03 — Rentals booking calendar.
    await recordSegment(browser, admin, "03-rentals-schedule.webm", async (page) => {
      await show(page, "/admin/schedule", {
        anchors: (p) => [
          p.getByText("Cage 1", { exact: false }),
          p.getByText(/\d{1,2}:\d{2}\s*(AM|PM)/i),
        ],
        caption: "Every cage and bullpen rental on a live booking calendar.",
        leadIn: ADMIN_LEAD,
      });
      await sleep(2200);
      await gentleScroll(page, 500);
      await sleep(1300);
    });

    // 04 — Work Log: heading + at least one table row.
    await recordSegment(browser, admin, "04-work-log.webm", async (page) => {
      await show(page, "/admin/hour-log", {
        anchors: (p) => [
          p.getByText("Marcus Bell", { exact: false }),
          p.getByText("HS Summer Program", { exact: false }),
          p.getByRole("heading", { name: "Work Log", exact: false }),
        ],
        caption: "Every coach's logged hours, with unscheduled ones flagged.",
        leadIn: ADMIN_LEAD,
      });
      await sleep(2200);
      await gentleScroll(page, 500);
      await sleep(1300);
    });

    // 05 — Attendance by-program. Stays on the POPULATED per-program grid for
    // the FULL dwell. We deliberately do NOT sub-navigate to the by-player tab:
    // that view lands on an EMPTY "Pick a player to view attendance." picker,
    // which would put an empty, caption-dropped frame at the segment midpoint.
    // The caption "by program or by player…" still reads fine over the grid.
    await recordSegment(browser, admin, "05-attendance.webm", async (page) => {
      await show(page, adminByProgramRoute, {
        anchors: (p) => [
          p.locator("table tbody tr").first(),
          p.getByText("HS Summer Program", { exact: false }),
          p.getByRole("heading", { name: "Attendance", exact: false }),
        ],
        caption:
          "Attendance by program or by player — with per-athlete session caps.",
        leadIn: ADMIN_LEAD,
      });
      await sleep(4200);
      await gentleScroll(page, 400);
      await sleep(1300);
    });

    // 06 — Roster: at least one athlete name row.
    await recordSegment(browser, admin, "06-roster.webm", async (page) => {
      await show(page, "/admin/attendance/roster", {
        anchors: (p) => [
          p.locator("table tbody tr").first(),
          p.getByRole("heading", { name: "Roster", exact: false }),
        ],
        caption:
          "Your full roster — athletes, programs, enrollments — in one place.",
        leadIn: ADMIN_LEAD,
      });
      await sleep(2200);
      await gentleScroll(page, 500);
      await sleep(1300);
    });

    // 07 — Reports: summary money figures + per-coach row.
    await recordSegment(browser, admin, "07-reports.webm", async (page) => {
      await show(page, "/admin/reports", {
        anchors: (p) => [
          p.getByText(/RENTAL OWED/i),
          p.getByText("Marcus Bell", { exact: false }),
          p.getByText(/\$\d/),
        ],
        caption:
          "What's owed for rentals vs. what each coach is paid — kept separate.",
        leadIn: ADMIN_LEAD,
      });
      await sleep(2200);
      await gentleScroll(page, 500);
      await sleep(1300);
    });

    // 08 — Payments: at least one payment/coach row with a $ amount.
    await recordSegment(browser, admin, "08-payments.webm", async (page) => {
      await show(page, "/admin/payments", {
        anchors: (p) => [
          p.getByText("Marcus Bell", { exact: false }),
          p.getByText(/\$\d/),
          p.getByRole("heading", { name: "Payments", exact: false }),
        ],
        caption: "Track every payment in and out — no spreadsheets.",
        leadIn: ADMIN_LEAD,
      });
      await sleep(2200);
      await gentleScroll(page, 500);
      await sleep(1300);
    });

    // 09 — Records hub.
    await recordSegment(browser, admin, "09-records-audit.webm", async (page) => {
      await show(page, "/admin/records", {
        anchors: (p) => [
          p.getByText("Coaches", { exact: false }),
          p.getByText("Audit", { exact: false }),
          p.getByRole("heading", { name: "Billing & Records", exact: false }),
        ],
        caption:
          "Manage coaches, import data, and a full audit log of every action.",
        leadIn: ADMIN_LEAD,
      });
      await sleep(2800);
      await gentleScroll(page, 200);
      await sleep(2000);
    });

    // 10 — coach: book a cage. Anchor: calendar resource rows + time slots.
    await recordSegment(browser, coach, "10-coach-book.webm", async (page) => {
      await show(page, "/coach/sessions/new", {
        anchors: (p) => [
          p.getByText("Cage 1", { exact: false }),
          p.getByText(/\d{1,2}:\d{2}\s*(AM|PM)/i),
        ],
        caption: "A coach grabs an open cage and books it in two taps.",
        leadIn: COACH_LEAD,
      });
      await sleep(2200);
      await gentleScroll(page, 400);
      await sleep(1300);
    });

    // 11 — coach: work log.
    await recordSegment(browser, coach, "11-coach-work-log.webm", async (page) => {
      await show(page, "/coach/hour-log", {
        anchors: (p) => [
          p.getByText("HS Summer Program", { exact: false }),
          p.getByRole("heading", { name: "Work Log", exact: false }),
          p.locator("form").first(),
        ],
        caption:
          "They log their own hours — or confirm scheduled work in one tap.",
        leadIn: COACH_LEAD,
      });
      await sleep(2200);
      await gentleScroll(page, 400);
      await sleep(1300);
    });

    // 12 — coach: attendance (a session with a roster of athlete checkboxes).
    await recordSegment(browser, coach, "12-coach-attendance.webm", async (page) => {
      await show(page, coachAttendanceRoute, {
        anchors: (p) => [
          p.locator('input[type="checkbox"]').first(),
          p.getByText("HS Summer Program", { exact: false }),
          p.getByRole("heading", { name: "Attendance", exact: false }),
        ],
        caption: "Take attendance for a session in a few checkboxes.",
        leadIn: COACH_LEAD,
      });
      // Raised dwell to clear the 5s caption-window floor (post-trim ≥ ~5.6s).
      await sleep(2800);
      await gentleScroll(page, 350);
      await sleep(2200);
    });

    // 13 — coach: schedule week.
    await recordSegment(browser, coach, "13-coach-schedule.webm", async (page) => {
      await show(page, "/coach/schedule", {
        anchors: (p) => [
          p.getByText("HS Summer Program", { exact: false }),
          p.getByText(/\d{1,2}:\d{2}\s*(AM|PM)/i),
          p.getByRole("heading", { name: "Schedule", exact: false }),
        ],
        caption: "Their whole week — programs and rentals — in one view.",
        leadIn: COACH_LEAD,
      });
      // Raised dwell to clear the 5s caption-window floor (post-trim ≥ ~5.6s).
      await sleep(2600);
      await gentleScroll(page, 350);
      await sleep(2200);
    });

    // 14 — coach: what you owe (scroll to the card).
    await recordSegment(browser, coach, "14-coach-owe.webm", async (page) => {
      await show(page, "/coach", {
        anchors: (p) => [
          p.getByText(/owe/i),
          p.getByText(/\$\d/),
        ],
        caption: "And exactly what they owe the facility, always current.",
        leadIn: COACH_LEAD,
      });
      // Raised dwell to clear the 5s caption-window floor (post-trim ≥ ~5.6s).
      await gentleScroll(page, 600);
      await sleep(2400);
      await gentleScroll(page, -300);
      await sleep(2000);
    });

    // 99 — outro card
    await recordCard(
      browser,
      admin,
      "99-outro.webm",
      cardHtml({
        logo: true,
        title: "Built to fit exactly how your facility runs.",
        footer: "Magna Software · magnathread.com",
      }),
      3000,
    );
  } finally {
    await browser.close();
    // Clean up the two session-token rows. Leave users (FK dependents).
    await db.delete(authSessions).where(eq(authSessions.sessionToken, adminToken));
    await db.delete(authSessions).where(eq(authSessions.sessionToken, coachToken));
    console.log("[rec] cleaned up demo session tokens.");
  }

  // Persist the caption manifest for the post step: slug → { leadIn, text }.
  const manifestPath = path.join(SEGMENTS_DIR, "captions.json");
  writeFileSync(manifestPath, JSON.stringify(captionManifest, null, 2) + "\n");
  console.log(`[rec] wrote caption manifest → ${manifestPath}`);

  console.log("[rec] all segments recorded.");
}

main().catch((err) => {
  console.error("[rec] record-demo FAILED:", err);
  process.exit(1);
});
