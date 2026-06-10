// Demo-video post-process.
//
// NEW MODEL (global caption bar): the recorded .webm segments are now CLEAN
// app screens — the caption bar is NO LONGER baked into them. This step:
//
//   1. Normalizes each clean .webm → 1080p H.264 mp4 (letterboxed, no audio)
//      into Sales/demo/segments/NN-slug.mp4 (FEATURE segments get the first
//      ~1.0s trimmed; the intro/outro brand CARDS are untrimmed).
//   2. Pre-renders, via Playwright, transparent-background PNG overlays:
//        - ONE constant bar PNG (black bottom bar + 3px yellow top border,
//          fully transparent above the bar) — the single continuous element.
//        - One text-only PNG per FEATURE segment (gray lead-in + big yellow
//          main caption, centered over the bar region, transparent elsewhere).
//   3. xfade-concats ALL normalized segments in order (00 intro … 99 outro)
//      into a single SCREEN track — this is the ONLY place a crossfade
//      happens, and it touches ONLY the app screens.
//   4. Composites, as a TOP layer drawn AFTER the xfade:
//        - the constant bar PNG at FULL opacity across the whole FEATURE span
//          (start of seg 01 → end of seg 14) — it never fades, never dims;
//        - each segment's text PNG, switched by time window
//          enable='between(t,start,end)' computed from the xfaded timeline
//          (start_i = start_{i-1} + dur_{i-1} - xfadeDur).
//      Result → Sales/demo/pfa-platform-demo-full.mp4.
//   5. Re-renders STANDALONE segment files: each FEATURE = clean content +
//      constant bar + that segment's text at full opacity for the whole clip
//      (no fade). Cards stay as-is.
//
// ffmpeg path is /opt/homebrew/bin/ffmpeg (override with FFMPEG_BIN). This
// ffmpeg build has NO drawtext (no libfreetype), so all text is rendered as
// PNG overlays via Playwright — which also gives exact style fidelity.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const FFMPEG = process.env.FFMPEG_BIN ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE =
  process.env.FFPROBE_BIN ?? FFMPEG.replace(/ffmpeg$/, "ffprobe");
const RAW_DIR = path.resolve(__dirname, "segments");
const CAPTIONS_JSON = path.join(RAW_DIR, "captions.json");
const OUT_ROOT =
  process.env.DEMO_OUT_DIR ??
  "/Users/jacobmagna/Magna Software LLC/Sales/demo";
const OUT_SEGMENTS = path.join(OUT_ROOT, "segments");
const FULL_OUT = path.join(OUT_ROOT, "pfa-platform-demo-full.mp4");
const PNG_DIR = path.join(RAW_DIR, "_overlays");

const W = 1920;
const H = 1080;
const FPS = 30;
const XFADE = 0.4; // crossfade duration between screens (seconds)
const TRIM_LEAD_SECONDS = 1.0; // feature lead-in trim
const BAR_H = Math.round(H * 0.22); // ~237px — same look as the old bar
const BRAND_YELLOW = "#FFC400";
const BRAND_BLACK = "#0a0a0a";

const SCALE_PAD =
  `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
  `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;

interface CaptionEntry {
  leadIn: string;
  text: string;
}

function run(args: string[]) {
  execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function probeDuration(file: string): number {
  const out = execFileSync(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ],
    { encoding: "utf8" },
  ).trim();
  const d = Number.parseFloat(out);
  if (!Number.isFinite(d) || d <= 0) {
    throw new Error(`Could not probe duration of ${file} (got "${out}")`);
  }
  return d;
}

const isCard = (slug: string) => /^00-/.test(slug) || /^99-/.test(slug);

// ---------------------------------------------------------------------------
// PNG overlays (Playwright). All 1920x1080, transparent background.
// ---------------------------------------------------------------------------

// The constant bar: black bottom bar with a 3px yellow top border. Everything
// above the bar is transparent (so the app screen shows through). One PNG,
// reused for the entire feature span.
function barHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
    #bar{position:fixed;left:0;right:0;bottom:0;height:${BAR_H}px;
      background:${BRAND_BLACK};border-top:3px solid ${BRAND_YELLOW};
      box-shadow:0 -8px 40px rgba(0,0,0,0.55)}
  </style></head><body><div id="bar"></div></body></html>`;
}

// Text-only overlay for one caption: gray lead-in + big yellow main, centered
// within the bar region. The bar itself is NOT drawn here (it is the constant
// PNG); only the text, on a transparent background, positioned over the bar.
function textHtml(entry: CaptionEntry): string {
  const lead = entry.leadIn
    ? `<div class="lead">${escapeHtml(entry.leadIn)}</div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${W}px;height:${H}px;background:transparent;overflow:hidden}
    #t{position:fixed;left:0;right:0;bottom:0;height:${BAR_H}px;
      display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
      text-align:center}
    .lead{color:rgba(255,255,255,0.55);font-size:20px;font-weight:600;
      letter-spacing:0.18em;text-transform:uppercase}
    .main{color:${BRAND_YELLOW};font-size:40px;font-weight:700;
      max-width:80vw;line-height:1.2}
  </style></head><body><div id="t">${lead}<div class="main">${escapeHtml(
    entry.text,
  )}</div></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function renderOverlays(
  featureSlugs: string[],
  captions: Record<string, CaptionEntry>,
): Promise<{ barPng: string; textPng: Record<string, string> }> {
  mkdirSync(PNG_DIR, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();

  const barPng = path.join(PNG_DIR, "bar.png");
  await page.setContent(barHtml(), { waitUntil: "networkidle" });
  await page.screenshot({ path: barPng, omitBackground: true });

  const textPng: Record<string, string> = {};
  for (const slug of featureSlugs) {
    const entry = captions[slug];
    if (!entry) {
      throw new Error(`No caption manifest entry for feature segment ${slug}`);
    }
    const out = path.join(PNG_DIR, `text-${slug}.png`);
    await page.setContent(textHtml(entry), { waitUntil: "networkidle" });
    await page.screenshot({ path: out, omitBackground: true });
    textPng[slug] = out;
  }

  await ctx.close();
  await browser.close();
  return { barPng, textPng };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(FFMPEG)) {
    throw new Error(`ffmpeg not found at ${FFMPEG} (set FFMPEG_BIN).`);
  }
  if (!existsSync(CAPTIONS_JSON)) {
    throw new Error(
      `Caption manifest not found at ${CAPTIONS_JSON}. Run record-demo first.`,
    );
  }
  const captions = JSON.parse(
    readFileSync(CAPTIONS_JSON, "utf8"),
  ) as Record<string, CaptionEntry>;

  mkdirSync(OUT_ROOT, { recursive: true });
  rmSync(OUT_SEGMENTS, { recursive: true, force: true });
  mkdirSync(OUT_SEGMENTS, { recursive: true });

  const webms = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".webm"))
    .sort(); // NN- prefix → lexical sort is segment order
  if (webms.length === 0) {
    throw new Error(`No .webm segments found in ${RAW_DIR}. Run record-demo first.`);
  }

  const slugs = webms.map((w) => w.replace(/\.webm$/, ""));
  const featureSlugs = slugs.filter((s) => !isCard(s));

  // --- 0. pre-render the bar + per-feature text PNGs ------------------------
  console.log("[post] rendering caption overlays (bar + per-segment text)…");
  const { barPng, textPng } = await renderOverlays(featureSlugs, captions);

  // --- 1. normalize each clean .webm → 1080p mp4 (no caption baked in) ------
  const mp4s: string[] = [];
  for (const webm of webms) {
    const slug = webm.replace(/\.webm$/, "");
    const base = `${slug}.mp4`;
    const dest = path.join(OUT_SEGMENTS, base);
    const trim = !isCard(slug);
    console.log(
      `[post] normalize ${webm} → segments/${base}${trim ? ` (trim ${TRIM_LEAD_SECONDS}s lead)` : ""}`,
    );
    run([
      "-y",
      ...(trim ? ["-ss", String(TRIM_LEAD_SECONDS)] : []),
      "-i",
      path.join(RAW_DIR, webm),
      "-vf",
      SCALE_PAD,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(FPS),
      "-crf",
      "20",
      "-an",
      "-movflags",
      "+faststart",
      dest,
    ]);
    mp4s.push(dest);
  }

  // --- 2. measure normalized durations + compute xfade-timeline windows -----
  const durations = mp4s.map((p) => probeDuration(p));
  // start_i in the xfaded timeline: start_0 = 0; start_i = start_{i-1} +
  // dur_{i-1} - XFADE. (Each xfade overlaps the previous clip by XFADE.)
  const starts: number[] = [0];
  for (let i = 1; i < durations.length; i++) {
    starts[i] = starts[i - 1] + durations[i - 1] - XFADE;
  }
  const totalDuration = starts[durations.length - 1] + durations[durations.length - 1];

  // Feature span in the xfaded timeline: from the START of the first feature
  // segment through the END of the last feature segment. Intro/outro cards
  // carry no bar.
  const firstFeatureIdx = slugs.findIndex((s) => !isCard(s));
  let lastFeatureIdx = -1;
  for (let i = 0; i < slugs.length; i++) if (!isCard(slugs[i])) lastFeatureIdx = i;
  const barStart = starts[firstFeatureIdx];
  const barEnd = starts[lastFeatureIdx] + durations[lastFeatureIdx];

  // --- 3+4. build the full tour: xfade the screens, then overlay bar+text ---
  console.log(
    `[post] xfade-concat ${mp4s.length} screens + constant bar/text → ${FULL_OUT}`,
  );

  const inputs: string[] = [];
  for (const p of mp4s) {
    inputs.push("-i", p);
  }
  // overlay PNG inputs: bar first, then one per feature segment (in order).
  const barInputIdx = mp4s.length;
  inputs.push("-loop", "1", "-i", barPng);
  const textInputIdx: Record<string, number> = {};
  let nextIdx = barInputIdx + 1;
  for (const slug of featureSlugs) {
    textInputIdx[slug] = nextIdx;
    inputs.push("-loop", "1", "-i", textPng[slug]);
    nextIdx += 1;
  }

  const fc: string[] = [];
  // Normalize each screen input (fps/format) so xfade has matching frames.
  for (let i = 0; i < mp4s.length; i++) {
    fc.push(
      `[${i}:v]fps=${FPS},format=yuv420p,setsar=1[s${i}]`,
    );
  }
  // xfade chain. offset_i (running timeline position where clip i fades in) =
  // start_i - XFADE = end of the accumulated chain minus the overlap.
  let prevLabel = "s0";
  for (let i = 1; i < mp4s.length; i++) {
    const offset = (starts[i] - XFADE).toFixed(4);
    const outLabel = i === mp4s.length - 1 ? "screens" : `x${i}`;
    fc.push(
      `[${prevLabel}][s${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset}[${outLabel}]`,
    );
    prevLabel = outLabel;
  }
  // Single-screen edge case: no xfade ran, alias s0 → screens.
  if (mp4s.length === 1) fc.push(`[s0]null[screens]`);

  // Overlay the CONSTANT bar over the feature span, full opacity, no fade.
  fc.push(`[${barInputIdx}:v]format=rgba,setsar=1[bar]`);
  fc.push(
    `[screens][bar]overlay=0:0:enable='between(t,${barStart.toFixed(4)},${barEnd.toFixed(4)})'[withbar]`,
  );

  // Overlay each feature segment's text, windowed [start_i, start_{i+1}) —
  // i.e. until the next segment begins (last feature extends to its end).
  // The bar underneath stays solid through every transition.
  let chain = "withbar";
  featureSlugs.forEach((slug, fi) => {
    const i = slugs.indexOf(slug);
    const tStart = starts[i];
    // window ends where the NEXT segment starts; for the last feature, at the
    // feature span end (the outro xfade begins right after).
    const tEnd = i + 1 < starts.length ? starts[i + 1] : barEnd;
    const tIdx = textInputIdx[slug];
    const last = fi === featureSlugs.length - 1;
    const outLabel = last ? "vout" : `t${fi}`;
    fc.push(`[${tIdx}:v]format=rgba,setsar=1[txt${fi}]`);
    fc.push(
      `[${chain}][txt${fi}]overlay=0:0:enable='between(t,${tStart.toFixed(4)},${tEnd.toFixed(4)})'[${outLabel}]`,
    );
    chain = outLabel;
  });

  run([
    "-y",
    ...inputs,
    "-filter_complex",
    fc.join(";"),
    "-map",
    "[vout]",
    "-t",
    totalDuration.toFixed(4),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(FPS),
    "-crf",
    "20",
    "-an",
    "-movflags",
    "+faststart",
    FULL_OUT,
  ]);

  // --- 5. standalone segment files: clean content + constant bar + text -----
  // (cards stay exactly as normalized; features get bar + their own text at
  // full opacity for the whole clip — no fade.)
  console.log("[post] compositing standalone segment files…");
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    const file = mp4s[i];
    if (isCard(slug)) continue; // cards already final
    const tmp = path.join(OUT_SEGMENTS, `_tmp_${slug}.mp4`);
    run([
      "-y",
      "-i",
      file,
      "-loop",
      "1",
      "-i",
      barPng,
      "-loop",
      "1",
      "-i",
      textPng[slug],
      "-filter_complex",
      [
        `[0:v]fps=${FPS},format=yuv420p,setsar=1[base]`,
        `[1:v]format=rgba,setsar=1[bar]`,
        `[2:v]format=rgba,setsar=1[txt]`,
        `[base][bar]overlay=0:0:shortest=1[wb]`,
        `[wb][txt]overlay=0:0:shortest=1[v]`,
      ].join(";"),
      "-map",
      "[v]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(FPS),
      "-crf",
      "20",
      "-an",
      "-movflags",
      "+faststart",
      tmp,
    ]);
    rmSync(file, { force: true });
    execFileSync("/bin/mv", [tmp, file]);
  }

  rmSync(PNG_DIR, { recursive: true, force: true });

  console.log("[post] post-process complete.");
  console.log(`[post] full tour: ${FULL_OUT}  (${totalDuration.toFixed(2)}s)`);
  console.log(`[post] segments:  ${OUT_SEGMENTS}`);
}

main().catch((err) => {
  console.error("[post] post-process FAILED:", err);
  process.exit(1);
});
