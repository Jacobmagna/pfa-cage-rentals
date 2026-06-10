// Demo-video post-process. Takes the raw per-segment .webm files in
// scripts/demo-video/segments/ and:
//   1. Normalizes each → 1080p H.264 mp4 (letterboxed, no audio) into
//      Sales/demo/segments/NN-slug.mp4.
//   2. Concatenates ALL normalized segments in order (00 intro … 99
//      outro), re-encoding for safety, into the full tour at
//      Sales/demo/pfa-platform-demo-full.mp4.
//
// ffmpeg path is /opt/homebrew/bin/ffmpeg (override with FFMPEG_BIN).

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const FFMPEG = process.env.FFMPEG_BIN ?? "/opt/homebrew/bin/ffmpeg";
const RAW_DIR = path.resolve(__dirname, "segments");
const OUT_ROOT =
  process.env.DEMO_OUT_DIR ??
  "/Users/jacobmagna/Magna Software LLC/Sales/demo";
const OUT_SEGMENTS = path.join(OUT_ROOT, "segments");
const FULL_OUT = path.join(OUT_ROOT, "pfa-platform-demo-full.mp4");

const SCALE_PAD =
  "scale=1920:1080:force_original_aspect_ratio=decrease," +
  "pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black";

function run(args: string[]) {
  execFileSync(FFMPEG, args, { stdio: ["ignore", "ignore", "inherit"] });
}

function main() {
  if (!existsSync(FFMPEG)) {
    throw new Error(`ffmpeg not found at ${FFMPEG} (set FFMPEG_BIN).`);
  }
  mkdirSync(OUT_ROOT, { recursive: true });
  // fresh segment outputs
  rmSync(OUT_SEGMENTS, { recursive: true, force: true });
  mkdirSync(OUT_SEGMENTS, { recursive: true });

  const webms = readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".webm"))
    .sort(); // NN- prefix → lexical sort is segment order
  if (webms.length === 0) {
    throw new Error(`No .webm segments found in ${RAW_DIR}. Run record-demo first.`);
  }

  const mp4s: string[] = [];
  for (const webm of webms) {
    const base = webm.replace(/\.webm$/, ".mp4");
    const dest = path.join(OUT_SEGMENTS, base);
    console.log(`[post] normalize ${webm} → segments/${base}`);
    run([
      "-y",
      "-i",
      path.join(RAW_DIR, webm),
      "-vf",
      SCALE_PAD,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-crf",
      "20",
      "-an",
      "-movflags",
      "+faststart",
      dest,
    ]);
    mp4s.push(dest);
  }

  // Concat via the demuxer, re-encoding for safety (mixed durations / GOPs).
  const listPath = path.join(OUT_SEGMENTS, "_concat.txt");
  writeFileSync(
    listPath,
    mp4s.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );
  console.log(`[post] concat ${mp4s.length} segments → ${FULL_OUT}`);
  run([
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-vf",
    SCALE_PAD,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-crf",
    "20",
    "-an",
    "-movflags",
    "+faststart",
    FULL_OUT,
  ]);
  rmSync(listPath, { force: true });

  console.log("[post] post-process complete.");
  console.log(`[post] full tour: ${FULL_OUT}`);
  console.log(`[post] segments:  ${OUT_SEGMENTS}`);
}

main();
