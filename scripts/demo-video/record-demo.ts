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
// Captions: a fixed bottom-third on-brand overlay, re-injected after
// every navigation. Intro/outro are full-screen brand cards rendered
// via page.setContent.
//
// Output: raw .webm per segment → scripts/demo-video/segments/NN-slug.webm.
// ffmpeg post-process (separate step) normalizes + concatenates.

import { chromium, type BrowserContext, type Page } from "playwright";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { demoDb } from "./db";
import { sessions as authSessions, users } from "../../src/db/schema";

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
// Caption overlay — injected into the page, persistent across the segment.
// ---------------------------------------------------------------------------

// Prime the overlay on the CURRENT page (typically about:blank, before the
// first goto). The init script only runs on a real navigation, so about:blank
// has neither cover nor caption — it would record as a white flash. This
// paints a full-screen black cover AND the caption bar (caption on top) right
// now, so the recording starts as "black screen + caption" instead of white.
async function primeOverlay(page: Page, text: string, leadIn?: string) {
  await page
    .evaluate(
      ({ text, leadIn, yellow, black }) => {
        const root = document.documentElement || document.body;
        if (!root) return;
        // Stash caption text in window.name — it SURVIVES the upcoming
        // same-tab navigation, so the next document's init script can restore
        // the caption text instantly (no empty-bar flash between documents).
        try {
          window.name = JSON.stringify({ __demoCap: { text, lead: leadIn ?? "" } });
        } catch {
          /* noop */
        }
        // Cover.
        if (!document.getElementById("__demo_cover__")) {
          const cover = document.createElement("div");
          cover.id = "__demo_cover__";
          cover.style.cssText =
            "position:fixed;inset:0;background:#0a0a0a;z-index:2147483646;" +
            "pointer-events:none;transition:opacity 350ms ease;opacity:1;";
          root.appendChild(cover);
        }
        // Caption (on top of cover).
        const ID = "__demo_caption__";
        let bar = document.getElementById(ID);
        if (!bar) {
          bar = document.createElement("div");
          bar.id = ID;
          bar.style.cssText = [
            "position:fixed",
            "left:0",
            "right:0",
            "bottom:0",
            "height:22vh",
            "background:" + black,
            "border-top:3px solid " + yellow,
            "z-index:2147483647",
            "pointer-events:none",
            "display:flex",
            "flex-direction:column",
            "align-items:center",
            "justify-content:center",
            "gap:10px",
            "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
            "box-shadow:0 -8px 40px rgba(0,0,0,0.55)",
          ].join(";");
          const lead = document.createElement("div");
          lead.id = ID + "_lead";
          lead.style.cssText =
            "color:rgba(255,255,255,0.55);font-size:20px;font-weight:600;" +
            "letter-spacing:0.18em;text-transform:uppercase;";
          const main = document.createElement("div");
          main.id = ID + "_main";
          main.style.cssText =
            "color:" +
            yellow +
            ";font-size:40px;font-weight:700;text-align:center;" +
            "max-width:80vw;line-height:1.2;";
          bar.appendChild(lead);
          bar.appendChild(main);
          root.appendChild(bar);
        }
        const lead = document.getElementById(ID + "_lead");
        const main = document.getElementById(ID + "_main");
        if (lead) {
          lead.textContent = leadIn ?? "";
          lead.style.display = leadIn ? "block" : "none";
        }
        if (main) main.textContent = text;
        bar.style.display = "flex";
      },
      { text, leadIn: leadIn ?? "", yellow: BRAND_YELLOW, black: BRAND_BLACK },
    )
    .catch(() => {});
  // Give the frame a moment to paint the primed overlay before we navigate.
  await sleep(150);
}

// Re-assert the FULL overlay (opaque cover + populated caption) on the
// just-parsed document, regardless of init-script timing. Resets the
// coverRemoved latch to false (this is a fresh page that must be covered)
// and re-applies caption text via the persisted-state setter when present.
async function forceOverlay(page: Page, text: string, leadIn?: string) {
  await page
    .evaluate(
      ({ text, leadIn, yellow, black }) => {
        const root = document.documentElement || document.body;
        if (!root) return;
        // Reset the cover latch so the cover is allowed up on this new page,
        // and (re)set the caption state via the init-script setter if it ran.
        const st = (
          window as unknown as {
            __demoOverlay?: { coverRemoved: boolean };
          }
        ).__demoOverlay;
        if (st) st.coverRemoved = false;
        const setter = (
          window as unknown as {
            __demoSetCaption?: (t: string, l: string) => void;
          }
        ).__demoSetCaption;
        // Body-hide style (kills any SSR skeleton paint; cover+caption on
        // <html> stay visible via the allow-list).
        let hide = document.getElementById("__demo_hide_style__");
        if (!hide) {
          hide = document.createElement("style");
          hide.id = "__demo_hide_style__";
          hide.textContent =
            // opacity:0 (not visibility:hidden) so Playwright still treats
            // in-body elements as "visible" for its waitFor checks, while the
            // skeleton is visually gone. Cover+caption live on <html>, not
            // body, so body opacity never affects them.
            "body{opacity:0 !important}";
          (document.head || root).appendChild(hide);
        }
        // Cover (opaque, full screen, just below the caption).
        let cover = document.getElementById("__demo_cover__");
        if (!cover) {
          cover = document.createElement("div");
          cover.id = "__demo_cover__";
          root.appendChild(cover);
        }
        cover.style.cssText =
          "position:fixed;inset:0;background:#0a0a0a;z-index:2147483646;" +
          "pointer-events:none;transition:opacity 350ms ease;opacity:1;";
        if (cover.parentElement !== root) root.appendChild(cover);
        // Caption (on top of cover).
        if (setter) {
          setter(text, leadIn);
        } else {
          const ID = "__demo_caption__";
          let bar = document.getElementById(ID);
          if (!bar) {
            bar = document.createElement("div");
            bar.id = ID;
            bar.style.cssText = [
              "position:fixed;left:0;right:0;bottom:0;height:22vh",
              "background:" + black,
              "border-top:3px solid " + yellow,
              "z-index:2147483647;pointer-events:none;display:flex",
              "flex-direction:column;align-items:center;justify-content:center;gap:10px",
              "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
            ].join(";");
            const lead = document.createElement("div");
            lead.id = ID + "_lead";
            lead.style.cssText =
              "color:rgba(255,255,255,0.55);font-size:20px;font-weight:600;" +
              "letter-spacing:0.18em;text-transform:uppercase;";
            const main = document.createElement("div");
            main.id = ID + "_main";
            main.style.cssText =
              "color:" +
              yellow +
              ";font-size:40px;font-weight:700;text-align:center;max-width:80vw;line-height:1.2;";
            bar.appendChild(lead);
            bar.appendChild(main);
            root.appendChild(bar);
          }
          const lead = document.getElementById(ID + "_lead");
          const main = document.getElementById(ID + "_main");
          if (lead) {
            lead.textContent = leadIn ?? "";
            lead.style.display = leadIn ? "block" : "none";
          }
          if (main) main.textContent = text;
          bar.style.display = "flex";
          if (bar.parentElement !== root) root.appendChild(bar);
        }
        // Caption must stay the LAST child (topmost) over the cover.
        const bar2 = document.getElementById("__demo_caption__");
        if (bar2 && bar2.parentElement === root) root.appendChild(bar2);
      },
      { text, leadIn: leadIn ?? "", yellow: BRAND_YELLOW, black: BRAND_BLACK },
    )
    .catch(() => {});
}

async function setCaption(page: Page, text: string, leadIn?: string) {
  // Source of truth is window.__demoOverlay (set up by the context init
  // script). __demoSetCaption persists text+lead+shown there and materializes
  // the bar from state; the MutationObserver/interval then keep it that way
  // through any hydration rebuild, so the caption never blanks. (Fallback
  // rebuild inline in case the init script global isn't present yet.)
  await page.evaluate(
    ({ text, leadIn }) => {
      const setter = (
        window as unknown as {
          __demoSetCaption?: (t: string, l: string) => void;
        }
      ).__demoSetCaption;
      if (setter) {
        setter(text, leadIn);
        return;
      }
      // Defensive fallback (should be unreachable once init script ran).
      const ID = "__demo_caption__";
      const root = document.documentElement || document.body;
      let bar = document.getElementById(ID);
      if (!bar) {
        bar = document.createElement("div");
        bar.id = ID;
        bar.style.cssText =
          "position:fixed;left:0;right:0;bottom:0;height:22vh;" +
          "background:#0a0a0a;border-top:3px solid #FFC400;z-index:2147483646;" +
          "pointer-events:none;display:flex;flex-direction:column;" +
          "align-items:center;justify-content:center;gap:10px;" +
          "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
        const main = document.createElement("div");
        main.id = ID + "_main";
        main.style.cssText =
          "color:#FFC400;font-size:40px;font-weight:700;text-align:center;" +
          "max-width:80vw;line-height:1.2;";
        bar.appendChild(main);
        root.appendChild(bar);
      }
      const main = document.getElementById(ID + "_main");
      if (main) main.textContent = text;
      bar.style.display = "flex";
    },
    { text, leadIn: leadIn ?? "" },
  );
  // Confirm the caption node is present + visible + carrying our text BEFORE
  // the caller lifts the cover, so the first revealed frame has the caption.
  await page
    .waitForFunction(
      (expected) => {
        const b = document.getElementById("__demo_caption__");
        const m = document.getElementById("__demo_caption___main");
        return (
          !!b &&
          b.style.display !== "none" &&
          !!m &&
          m.textContent === expected
        );
      },
      text,
      { timeout: 4_000, polling: 50 },
    )
    .catch(() => {});
}

// Re-assert the caption stays on top after a scroll. Scrolling can reveal
// sticky/absolutely-positioned app chrome; this moves the caption back to
// the end of <body> and forces its z-index, without changing its text.
async function raiseCaption(page: Page) {
  await page
    .evaluate(() => {
      const bar = document.getElementById("__demo_caption__");
      const root = document.documentElement || document.body;
      if (bar && root) {
        bar.style.zIndex = "2147483646";
        // Re-pin to <html> (last child) so it stays topmost after a scroll.
        root.appendChild(bar);
      }
    })
    .catch(() => {});
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// True when NO loading state remains: no Tailwind skeleton-pulse element
// AND no route loading.tsx shell (LoadingShell renders role="status"
// aria-live="polite"). Evaluated in-page.
function noLoadingState(): boolean {
  if (document.querySelectorAll(".animate-pulse").length > 0) return false;
  // The route-segment skeleton shell. Match the LoadingShell signature
  // (role=status + aria-live=polite) rather than ALL role=status (toasts
  // etc. also use status) so we only key off the loading fallback.
  const shells = document.querySelectorAll(
    '[role="status"][aria-live="polite"]',
  );
  for (const s of Array.from(shells)) {
    if ((s.textContent || "").toLowerCase().includes("loading")) return false;
  }
  return true;
}

// Wait for the page's real content to appear: a visible <h1> with
// non-empty text, an optional page-specific heading/sentinel, AND no
// remaining loading state (skeleton-pulse placeholders OR the route
// loading.tsx shell). Tolerant — returns after the timeout either way so
// a flaky page never aborts the recording. Generous timeouts: this runs
// UNDER the black cover, so waiting longer never shows a bad frame.
async function waitForContent(
  page: Page,
  headingText?: string,
  readyText?: string,
) {
  // First, a visible heading with text.
  await page
    .locator("h1")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => {});
  if (headingText) {
    await page
      .getByRole("heading", { name: headingText, exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 25_000 })
      .catch(() => {});
  }
  // A page-specific "real content has loaded" sentinel (e.g. a table row
  // or a known label) — only present once the route-segment loading.tsx
  // skeleton has been replaced by the real page.
  if (readyText) {
    await page
      .getByText(readyText, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 25_000 })
      .catch(() => {});
  }
  // Then wait for ALL loading state to clear — and STAY clear, so a page
  // that renders a heading, then streams a second deferred chunk as its
  // own skeleton (e.g. the work-log / reports / audit table) isn't revealed
  // during the gap. Heavy admin pages render the route loading.tsx skeleton,
  // briefly clear it, then re-skeleton the streamed table — so require the
  // clear state to HOLD across MULTIPLE consecutive readings over ~1.5s, not
  // just one transient clear moment. STRICTLY BOUNDED so it can never stall:
  // two clear checks ~800ms apart, each capped at 12s. This all happens UNDER
  // the body-hide + cover, so even if a streamed skeleton slips past these
  // checks it is never visible; the checks just bias the reveal toward a
  // loaded page. (No unbounded stability loop — that risked an infinite wait
  // on a page that perpetually re-skeletons.)
  const loadingGone = () =>
    page
      .waitForFunction(noLoadingState, undefined, {
        timeout: 12_000,
        polling: 150,
      })
      .catch(() => {});
  await loadingGone();
  await sleep(800);
  await loadingGone();
}

// Robust navigate: go to the route, wait for REAL content (heading +
// no skeletons), THEN set the caption so the whole captioned dwell shows
// loaded data. Never throws on a flaky selector.
async function show(
  page: Page,
  route: string,
  opts: {
    waitFor?: string;
    readyText?: string;
    caption: string;
    leadIn?: string;
    settleMs?: number;
  } = {
    caption: "",
  },
) {
  // Paint the cover + set the caption on the CURRENT page (about:blank or the
  // prior route) BEFORE navigating. This kills the white about:blank flash at
  // the very start of the recording and means the caption is already showing
  // (on top of the black cover) from the FIRST recorded frame — so a slow
  // page load is just "black screen with the caption", never a blank/skeleton.
  await primeOverlay(page, opts.caption, opts.leadIn);
  const gotoStart = Date.now();
  try {
    // waitUntil:"commit" returns the instant the navigation commits — BEFORE
    // the SSR body (loading skeleton) parses and paints. We then forceOverlay
    // immediately, so the cover + body-hide are applied ahead of the skeleton's
    // first paint, closing the recording-start race where the encoder would
    // otherwise capture a few bare-skeleton frames at t≈0.
    await page.goto(`${BASE_URL}${route}`, {
      waitUntil: "commit",
      timeout: 45_000,
    });
  } catch (e) {
    console.warn(`[rec] goto ${route} slow/failed: ${(e as Error).message.slice(0, 80)}`);
  }
  // Belt-and-braces: explicitly re-assert the cover + caption the instant the
  // new document is parsed (domcontentloaded). The document-start init script
  // SHOULD have painted the cover already, but on a fast warmed page the SSR
  // loading skeleton can win the first-paint race — this guarantees the cover
  // is back on top (and the caption set) right after parse, hiding it.
  await forceOverlay(page, opts.caption, opts.leadIn);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // Re-set the caption on the freshly-navigated document (on top of the cover).
  await setCaption(page, opts.caption, opts.leadIn);
  // All of this runs UNDER the opaque black cover, so the loading skeleton is
  // never visible — the viewer sees the black cover WITH the caption on it.
  await waitForContent(page, opts.waitFor, opts.readyText);
  await sleep(opts.settleMs ?? 400);
  // Hold the cover up for a guaranteed MINIMUM wall-clock time from goto so
  // the recording's early frames (≈0.5s, 1.0s in) are reliably the
  // black-cover-WITH-caption phase on EVERY segment — fast or slow — not a
  // content frame missing the caption. Invisible (still black), so harmless.
  const MIN_COVER_MS = 2600;
  const elapsed = Date.now() - gotoStart;
  if (elapsed < MIN_COVER_MS) await sleep(MIN_COVER_MS - elapsed);
  // Confirm the caption is set + visible, THEN lift the cover — so the frame
  // where content appears already carries the caption (which never left).
  await setCaption(page, opts.caption, opts.leadIn);
  await revealPage(page);
}

async function gentleScroll(page: Page, dy: number) {
  await page.mouse.wheel(0, dy);
  // Scrolling can reveal sticky/absolute app chrome that paints over the
  // caption; re-assert it stays pinned on top before we dwell.
  await raiseCaption(page);
  await sleep(700);
  await raiseCaption(page);
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
  // Paint a full-screen black cover AND the bottom-third caption bar at
  // document-start on EVERY navigation, BEFORE any skeleton paints. Both are
  // mounted as direct children of <html> (document.documentElement), NOT
  // inside <body>/#__next — React only reconciles nodes inside its root
  // container, so mounting outside it means Next.js client hydration / route
  // transition reconciliation can NEVER remove or wipe these nodes. (Earlier
  // the caption lived in <body> and hydration deleted it right after the
  // cover lifted, so it reappeared ~1.5–2s late — that's the bug this fixes.)
  //
  // z-order: cover (MAX 2147483647) sits one ABOVE the caption
  // (2147483646), so while it's up it hides EVERYTHING — caption area,
  // hydration flashes, route loading skeleton. show() sets the caption text
  // under the cover, then fades the cover out, so the first visible frame is
  // fully-loaded content WITH the caption already on screen.
  //
  // A MutationObserver re-appends either node to <html> if it's ever detached
  // and re-asserts z-index/topmost ordering; a setInterval is a belt-and-
  // braces fallback in case observer callbacks are starved during heavy work.
  await ctx.addInitScript(
    ({ yellow, black }) => {
      const root = () => document.documentElement || document.body || document;
      // The caption sits ABOVE the full-screen cover (CAP_Z > COVER_Z). The
      // cover (opaque black, full screen) hides the loading skeleton; the
      // caption is a bottom-third black bar painted on top of it, so the
      // caption is visible from the VERY FIRST frame — even while the page
      // loads behind the cover — and simply stays put when the cover lifts to
      // reveal the loaded content. Both are black, so cover+caption read as
      // one black screen during load, then content fades in above the bar.
      const CAP_Z = "2147483647";
      const COVER_Z = "2147483646";

      // Persisted overlay state lives on window — survives DOM rebuilds. The
      // observer rebuilds nodes FROM this state, so even if React hydration
      // nukes a node, it comes back fully populated (caption text + visible),
      // never blank. `coverRemoved` is a one-way latch: once the recorder
      // fades the cover out, the observer/interval must NOT recreate it.
      interface OverlayState {
        capText: string;
        capLead: string;
        capShown: boolean;
        coverRemoved: boolean;
      }
      const w = window as unknown as { __demoOverlay?: OverlayState };
      if (!w.__demoOverlay) {
        // Restore caption text carried across the navigation via window.name
        // (set by primeOverlay before goto) so the caption is populated from
        // the very first paint of the new document — no empty-bar flash.
        let carried = { text: "", lead: "" };
        try {
          const parsed = JSON.parse(window.name || "{}");
          if (parsed && parsed.__demoCap) carried = parsed.__demoCap;
        } catch {
          /* noop */
        }
        w.__demoOverlay = {
          capText: carried.text,
          capLead: carried.lead,
          capShown: !!carried.text,
          coverRemoved: false,
        };
      }
      const state = w.__demoOverlay;

      // BULLETPROOF SSR-RACE GUARD: inject a <style> at document-start that
      // makes <body> fully transparent (opacity:0) until reveal. The cover +
      // caption are children of <html>, NOT body, so they stay fully opaque.
      // This means the SSR loading skeleton (which lives in body) can NEVER
      // paint a VISIBLE frame even if the cover div loses the first-paint race
      // — body is transparent until __demoRemoveCover removes this style. We
      // use opacity:0 (not visibility:hidden) so Playwright still treats
      // in-body elements as "visible" for its waitFor() checks. Belt to the
      // cover's braces; together they guarantee no skeleton is ever shown.
      const ensureHide = () => {
        if (state.coverRemoved) return;
        let st = document.getElementById("__demo_hide_style__");
        if (!st) {
          st = document.createElement("style");
          st.id = "__demo_hide_style__";
          st.textContent =
            // opacity:0 (not visibility:hidden) so Playwright still treats
            // in-body elements as "visible" for its waitFor checks, while the
            // skeleton is visually gone. Cover+caption live on <html>, not
            // body, so body opacity never affects them.
            "body{opacity:0 !important}";
          (document.head || document.documentElement || document).appendChild(st);
        }
      };

      const ensureCover = () => {
        // Never resurrect the cover once it's been intentionally lifted.
        if (state.coverRemoved) return null;
        let cover = document.getElementById("__demo_cover__");
        if (!cover) {
          cover = document.createElement("div");
          cover.id = "__demo_cover__";
          cover.style.cssText =
            "position:fixed;inset:0;background:#0a0a0a;z-index:" +
            COVER_Z +
            ";pointer-events:none;transition:opacity 350ms ease;opacity:1;";
        }
        cover.style.zIndex = COVER_Z;
        if (cover.parentElement !== root()) root().appendChild(cover);
        return cover;
      };

      // (Re)build the caption bar mounted on <html>. ALWAYS re-applies the
      // persisted text/lead/visibility from `state`, so a hydration rebuild
      // can't leave it blank or hidden — it reappears exactly as last set.
      const ensureCaption = () => {
        const ID = "__demo_caption__";
        let bar = document.getElementById(ID);
        if (!bar) {
          bar = document.createElement("div");
          bar.id = ID;
          bar.style.cssText = [
            "position:fixed",
            "left:0",
            "right:0",
            "bottom:0",
            "height:22vh",
            "background:" + black,
            "border-top:3px solid " + yellow,
            "z-index:" + CAP_Z,
            "pointer-events:none",
            "flex-direction:column",
            "align-items:center",
            "justify-content:center",
            "gap:10px",
            "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
            "box-shadow:0 -8px 40px rgba(0,0,0,0.55)",
          ].join(";");
          const lead = document.createElement("div");
          lead.id = ID + "_lead";
          lead.style.cssText =
            "color:rgba(255,255,255,0.55);font-size:20px;font-weight:600;" +
            "letter-spacing:0.18em;text-transform:uppercase;";
          const main = document.createElement("div");
          main.id = ID + "_main";
          main.style.cssText =
            "color:" +
            yellow +
            ";font-size:40px;font-weight:700;text-align:center;" +
            "max-width:80vw;line-height:1.2;";
          bar.appendChild(lead);
          bar.appendChild(main);
        }
        // Re-apply persisted content + visibility every time.
        const lead = document.getElementById(ID + "_lead");
        const main = document.getElementById(ID + "_main");
        if (lead) {
          lead.textContent = state.capLead;
          lead.style.display = state.capLead ? "block" : "none";
        }
        if (main) main.textContent = state.capText;
        bar.style.display = state.capShown ? "flex" : "none";
        bar.style.zIndex = CAP_Z;
        // Keep the caption the LAST child of <html> so the cover (appended
        // after) stays painted above it while up; setCaption re-asserts this.
        if (bar.parentElement !== root()) root().appendChild(bar);
        return bar;
      };

      // Exposed to the recorder: set caption text + lead, mark shown, and
      // immediately materialize it from state.
      (
        window as unknown as {
          __demoSetCaption?: (text: string, lead: string) => void;
        }
      ).__demoSetCaption = (text: string, lead: string) => {
        state.capText = text;
        state.capLead = lead;
        state.capShown = true;
        ensureCaption();
      };

      // Exposed to the recorder: latch the cover removed + fade/remove it AND
      // drop the body-hide style so the real content becomes visible.
      (window as unknown as { __demoRemoveCover?: () => void }).__demoRemoveCover =
        () => {
          state.coverRemoved = true;
          const hide = document.getElementById("__demo_hide_style__");
          if (hide) hide.remove();
          const c = document.getElementById("__demo_cover__");
          if (c) {
            c.style.opacity = "0";
            setTimeout(() => c.remove(), 400);
          }
        };

      const ensureAll = () => {
        // Body-hide first (kills any skeleton paint), then cover, then caption
        // last (so it's the topmost <html> child painted over the cover).
        ensureHide();
        ensureCover();
        ensureCaption();
      };

      ensureAll();
      document.addEventListener("DOMContentLoaded", ensureAll);

      // Re-append/rebuild on ANY subtree mutation (hydration, route swap) —
      // <html>-level nodes stay put AND re-populate from state. Cheap: only
      // touches the DOM when a node has actually been detached/blanked.
      const needsFix = () => {
        const r = root();
        const cap = document.getElementById("__demo_caption__");
        const main = document.getElementById("__demo_caption___main");
        const cov = document.getElementById("__demo_cover__");
        if (!cap || cap.parentElement !== r) return true;
        if (state.capShown && (cap.style.display === "none" || !main)) return true;
        if (state.capShown && main && main.textContent !== state.capText) return true;
        if (!state.coverRemoved && (!cov || cov.parentElement !== r)) return true;
        return false;
      };
      const obs = new MutationObserver(() => {
        if (needsFix()) ensureAll();
      });
      const startObs = () =>
        obs.observe(root(), { childList: true, subtree: true });
      if (document.documentElement) startObs();
      else document.addEventListener("DOMContentLoaded", startObs);

      // Fallback: if observer callbacks are ever starved during heavy work,
      // this still keeps the overlays attached, populated, and topmost.
      setInterval(ensureAll, 200);
    },
    { yellow: BRAND_YELLOW, black: BRAND_BLACK },
  );
  return ctx;
}

/** Fade out + remove the black load-cover — but ONLY once NO loading
 * state (skeleton pulse OR route loading.tsx shell) remains, so we never
 * reveal a half-loaded page. A last-line defense behind waitForContent;
 * waits up to ~12s more for a late-streaming chunk, reveals anyway after
 * that (better a brief streamed chunk than a frozen recording). */
async function revealPage(page: Page) {
  await page
    .waitForFunction(noLoadingState, undefined, { timeout: 12_000, polling: 150 })
    .catch(() => {});
  // Let any final React hydration / route-transition DOM churn finish while
  // STILL under the (invisible) black cover — so when we lift it the DOM is
  // settled and the caption won't be transiently detached on the reveal frame.
  await sleep(450);
  // Re-assert the caption on the settled DOM, then CONFIRM it's present,
  // visible, carrying our text, AND the last child of <html> (topmost), with
  // a short stability poll — only THEN lift the cover. This guarantees the
  // very frame the content appears already carries the caption.
  await page
    .evaluate(() => {
      const setter = (
        window as unknown as { __demoSetCaption?: (t: string, l: string) => void }
      ).__demoSetCaption;
      const st = (
        window as unknown as {
          __demoOverlay?: { capText: string; capLead: string };
        }
      ).__demoOverlay;
      if (setter && st) setter(st.capText, st.capLead);
    })
    .catch(() => {});
  await page
    .waitForFunction(
      () => {
        const root = document.documentElement;
        const bar = document.getElementById("__demo_caption__");
        const main = document.getElementById("__demo_caption___main");
        return (
          !!bar &&
          bar.parentElement === root &&
          bar.style.display !== "none" &&
          !!main &&
          !!main.textContent
        );
      },
      undefined,
      { timeout: 4_000, polling: 50 },
    )
    .catch(() => {});
  await page
    .evaluate(() => {
      // Latch coverRemoved + fade/remove via the init-script helper so the
      // observer/interval never resurrects the cover over loaded content.
      const remover = (window as unknown as { __demoRemoveCover?: () => void })
        .__demoRemoveCover;
      if (remover) {
        remover();
        return;
      }
      const c = document.getElementById("__demo_cover__");
      if (c) {
        c.style.opacity = "0";
        setTimeout(() => c.remove(), 400);
      }
    })
    .catch(() => {});
  await sleep(400);
  // POST-REVEAL SKELETON GUARD (bounded LOOP, max 4 passes ≈ ≤28s — cannot
  // infinite-loop): a heavy page (notably Work Log) can re-enter the route
  // skeleton one or more times just after the cover lifts (client refetch /
  // Suspense retry). Each pass: if the route skeleton (>3 pulse rows) is up,
  // re-hide body + re-cover (caption stays on top), wait UP TO 6s for it to
  // clear, then lift again and re-check. After 4 passes we proceed regardless
  // (a perpetually-skeletoning page can't stall the run).
  for (let pass = 0; pass < 4; pass++) {
    const skeletonNow = await page
      .evaluate(() => document.querySelectorAll(".animate-pulse").length > 3)
      .catch(() => false);
    if (!skeletonNow) break;
    await page
      .evaluate(() => {
        const st = (
          window as unknown as { __demoOverlay?: { coverRemoved: boolean } }
        ).__demoOverlay;
        if (st) st.coverRemoved = false;
        const root = document.documentElement || document.body;
        let hide = document.getElementById("__demo_hide_style__");
        if (!hide) {
          hide = document.createElement("style");
          hide.id = "__demo_hide_style__";
          hide.textContent = "body{opacity:0 !important}";
          (document.head || root).appendChild(hide);
        }
        let c = document.getElementById("__demo_cover__");
        if (!c) {
          c = document.createElement("div");
          c.id = "__demo_cover__";
          root.appendChild(c);
        }
        c.style.cssText =
          "position:fixed;inset:0;background:#0a0a0a;z-index:2147483646;" +
          "pointer-events:none;opacity:1;";
        if (c.parentElement !== root) root.appendChild(c);
        const bar = document.getElementById("__demo_caption__");
        if (bar && bar.parentElement === root) root.appendChild(bar);
      })
      .catch(() => {});
    await page
      .waitForFunction(
        () => document.querySelectorAll(".animate-pulse").length <= 3,
        undefined,
        { timeout: 6_000, polling: 150 },
      )
      .catch(() => {});
    // Hold the clear state a beat under cover so a quick re-skeleton is caught
    // on the next pass rather than slipping through right after the lift.
    await sleep(700);
    await page
      .evaluate(() => {
        const remover = (
          window as unknown as { __demoRemoveCover?: () => void }
        ).__demoRemoveCover;
        if (remover) remover();
        else {
          const c = document.getElementById("__demo_cover__");
          if (c) {
            c.style.opacity = "0";
            setTimeout(() => c.remove(), 400);
          }
        }
      })
      .catch(() => {});
    await sleep(400);
  }
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
  // Cards are instant + have no skeleton/caption — directly drop the body-hide
  // style + the cover so the card is fully visible, latching coverRemoved so
  // the observer can't re-add them. (Don't use the app-page revealPage() —
  // its skeleton guard + caption-confirm waits would inflate/garble the card.)
  // Retry the reveal a few times: setContent + the document-start init script
  // can race, and the card must end up visible (not a blank/transparent body).
  for (let i = 0; i < 3; i++) {
    await page
      .evaluate(() => {
        const st = (
          window as unknown as { __demoOverlay?: { coverRemoved: boolean } }
        ).__demoOverlay;
        if (st) st.coverRemoved = true;
        const hide = document.getElementById("__demo_hide_style__");
        if (hide) hide.remove();
        const c = document.getElementById("__demo_cover__");
        if (c) c.remove();
        const cap = document.getElementById("__demo_caption__");
        if (cap) cap.remove();
        // Defensively force body fully opaque/visible in case any stray rule
        // left it transparent (the card supplies its own black background).
        if (document.body) {
          document.body.style.setProperty("opacity", "1", "important");
          document.body.style.setProperty("visibility", "visible", "important");
        }
      })
      .catch(() => {});
    await sleep(150);
  }
  // Keep the recording "active" across the hold with periodic micro-repaints —
  // Playwright's recordVideo under-captures a fully-static page (which can
  // yield a ~1s clip even though we hold for holdMs). A 1px transform nudge
  // every ~300ms forces frames without any visible change.
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
  const videoDir = path.join(SEGMENTS_DIR, `_tmp_${outName}`);
  const ctx = await newSegmentContext(browser, cookie, videoDir);
  const page = await ctx.newPage();
  await fn(page);
  await finishSegment(ctx, page, videoDir, outName);
  rmSync(videoDir, { recursive: true, force: true });
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
    for (const route of routes) {
      try {
        await warmPage.goto(`${BASE_URL}${route}`, {
          waitUntil: "networkidle",
          timeout: 60_000,
        });
        await waitForContent(warmPage);
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
      3300,
    );

    // 01 — Master Schedule at top of Home
    await recordSegment(browser, admin, "01-home-schedule.webm", async (page) => {
      await show(page, "/admin", {
        waitFor: "Home",
        caption:
          "Your whole facility's day on one schedule — drag to book, click to edit.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
    });

    // 02 — Home: scroll to Needs review + Recent activity
    await recordSegment(browser, admin, "02-home-needs-review.webm", async (page) => {
      await show(page, "/admin", {
        waitFor: "Home",
        caption:
          "It flags what needs attention — no-shows, unlogged hours, cancellations.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await gentleScroll(page, 900);
      await gentleScroll(page, 700);
      await sleep(1800);
    });

    // 03 — Rentals booking calendar (+ brief hub + sessions)
    await recordSegment(browser, admin, "03-rentals-schedule.webm", async (page) => {
      await show(page, "/admin/schedule", {
        caption: "Every cage and bullpen rental on a live booking calendar.",
        leadIn: ADMIN_LEAD,
        settleMs: 400,
      });
      await sleep(2000);
      await gentleScroll(page, 500);
      await sleep(1100);
    });

    // 04 — Work Log
    await recordSegment(browser, admin, "04-work-log.webm", async (page) => {
      await show(page, "/admin/hour-log", {
        waitFor: "Work Log",
        caption: "Every coach's logged hours, with unscheduled ones flagged.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
      await gentleScroll(page, 500);
      await sleep(1100);
    });

    // 05 — Attendance by-program then by-player
    await recordSegment(browser, admin, "05-attendance.webm", async (page) => {
      await show(page, "/admin/attendance/by-program", {
        waitFor: "Attendance",
        caption:
          "Attendance by program or by player — with per-athlete session caps.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
      await show(page, "/admin/attendance/by-player", {
        waitFor: "Attendance",
        caption:
          "Attendance by program or by player — with per-athlete session caps.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await sleep(1800);
    });

    // 06 — Roster
    await recordSegment(browser, admin, "06-roster.webm", async (page) => {
      await show(page, "/admin/attendance/roster", {
        caption:
          "Your full roster — athletes, programs, enrollments — in one place.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
      await gentleScroll(page, 500);
      await sleep(1100);
    });

    // 07 — Reports
    await recordSegment(browser, admin, "07-reports.webm", async (page) => {
      await show(page, "/admin/reports", {
        waitFor: "Reports",
        caption:
          "What's owed for rentals vs. what each coach is paid — kept separate.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
      await gentleScroll(page, 500);
      await sleep(1100);
    });

    // 08 — Payments
    await recordSegment(browser, admin, "08-payments.webm", async (page) => {
      await show(page, "/admin/payments", {
        waitFor: "Payments",
        caption: "Track every payment in and out — no spreadsheets.",
        leadIn: ADMIN_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
      await gentleScroll(page, 500);
      await sleep(1100);
    });

    // 09 — Records hub: Coaches / Accountability / Reports / Payments /
    // Audit log / Historical import / Settings cards, each with a live count.
    // This is the "Billing & Records" home and surfaces the audit log entry
    // point directly. We end the admin tour here on the hub (which renders
    // fast + clean) rather than navigating into the audit *table*, whose
    // date-filtered query streams slowly on the demo DB and would show a
    // loading skeleton mid-shot — the hub already conveys the caption.
    await recordSegment(browser, admin, "09-records-audit.webm", async (page) => {
      await show(page, "/admin/records", {
        waitFor: "Billing & Records",
        caption:
          "Manage coaches, import data, and a full audit log of every action.",
        leadIn: ADMIN_LEAD,
        settleMs: 400,
      });
      await sleep(2600);
      await gentleScroll(page, 200);
      await sleep(1800);
    });

    // 10 — coach: book a cage
    await recordSegment(browser, coach, "10-coach-book.webm", async (page) => {
      await show(page, "/coach/sessions/new", {
        caption: "A coach grabs an open cage and books it in two taps.",
        leadIn: COACH_LEAD,
        settleMs: 400,
      });
      await sleep(2000);
      await gentleScroll(page, 400);
      await sleep(1100);
    });

    // 11 — coach: work log
    await recordSegment(browser, coach, "11-coach-work-log.webm", async (page) => {
      await show(page, "/coach/hour-log", {
        caption:
          "They log their own hours — or confirm scheduled work in one tap.",
        leadIn: COACH_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
      await gentleScroll(page, 400);
      await sleep(1100);
    });

    // 12 — coach: attendance
    await recordSegment(browser, coach, "12-coach-attendance.webm", async (page) => {
      await show(page, "/coach/attendance", {
        waitFor: "Attendance",
        caption: "Take attendance for a session in a few checkboxes.",
        leadIn: COACH_LEAD,
        settleMs: 300,
      });
      await sleep(2000);
    });

    // 13 — coach: schedule week
    await recordSegment(browser, coach, "13-coach-schedule.webm", async (page) => {
      await show(page, "/coach/schedule", {
        caption: "Their whole week — programs and rentals — in one view.",
        leadIn: COACH_LEAD,
        settleMs: 400,
      });
      await sleep(1800);
    });

    // 14 — coach: what you owe
    await recordSegment(browser, coach, "14-coach-owe.webm", async (page) => {
      await show(page, "/coach", {
        caption:
          "And exactly what they owe the facility, always current.",
        leadIn: COACH_LEAD,
        settleMs: 300,
      });
      await gentleScroll(page, 600);
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
      3300,
    );
  } finally {
    await browser.close();
    // Clean up the two session-token rows. Leave users (FK dependents).
    await db.delete(authSessions).where(eq(authSessions.sessionToken, adminToken));
    await db.delete(authSessions).where(eq(authSessions.sessionToken, coachToken));
    console.log("[rec] cleaned up demo session tokens.");
  }

  console.log("[rec] all segments recorded.");
}

main().catch((err) => {
  console.error("[rec] record-demo FAILED:", err);
  process.exit(1);
});
