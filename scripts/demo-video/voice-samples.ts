// Generate ElevenLabs audition SAMPLES for the demo voiceover.
//
// Lists the account's real voices, picks 3–4 professional narrator voices,
// synthesizes one representative caption line with each, and prints a table
// (name → voice_id → sample path) so a voice can be picked.
//
// Run: `npx tsx scripts/demo-video/voice-samples.ts`

import path from "node:path";

import {
  SAMPLE_LINE,
  SAMPLES_DIR,
  listVoices,
  pickAuditionVoices,
  synthToFile,
} from "./audio";

async function main() {
  console.log("[samples] listing account voices…");
  const voices = await listVoices();
  console.log(`[samples] account has ${voices.length} voices.`);

  const picked = pickAuditionVoices(voices, 4);
  if (picked.length === 0) {
    throw new Error("No voices available on this account.");
  }

  const rows: { name: string; id: string; file: string }[] = [];
  for (const v of picked) {
    const safe = v.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const out = path.join(SAMPLES_DIR, `voice-${safe}.mp3`);
    process.stdout.write(`[samples] synth "${v.name}" (${v.voice_id})… `);
    const bytes = await synthToFile(SAMPLE_LINE, v.voice_id, out);
    console.log(`${(bytes / 1024).toFixed(1)} KB → ${out}`);
    rows.push({ name: v.name, id: v.voice_id, file: out });
  }

  console.log("\n=== VOICE SAMPLE TABLE (audition these) ===");
  console.log(`Line: "${SAMPLE_LINE}"\n`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(10)}  ${r.id.padEnd(24)}  ${r.file}`);
  }
  console.log(
    "\nPick one, then set VOICE_ID in scripts/demo-video/audio.ts " +
      "(or run with DEMO_VOICE_ID=<id>).",
  );
}

main().catch((err) => {
  console.error("[samples] FAILED:", err);
  process.exit(1);
});
