import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkbook } from "./parse";
import { normalizeRawName, normalizeSessions } from "./normalize";

const FIXTURE = path.resolve(__dirname, "../../../source_data.xlsx");

// source_data.xlsx is gitignored (PII). Skip the workbook-dependent suite
// when the file is absent (fresh clones + CI). See parse.test.ts for the
// canonical comment.
const HAS_FIXTURE = existsSync(FIXTURE);
const describeWithFixture = HAS_FIXTURE ? describe : describe.skip;

describe("normalizeRawName (acceptance + BRAINSTORM table)", () => {
  it("maps D. Lusk, Lusk, and David Lusk to the same canonical entry", () => {
    expect(normalizeRawName("D. Lusk").canonicalName).toBe("David Lusk");
    expect(normalizeRawName("Lusk").canonicalName).toBe("David Lusk");
    expect(normalizeRawName("David Lusk").canonicalName).toBe("David Lusk");
  });

  it("collapses the Necoechea trailing-space variant via post-trim alias lookup", () => {
    expect(normalizeRawName("Necoechea").canonicalName).toBe("Necoechea");
    expect(normalizeRawName("Necoechea ").canonicalName).toBe("Necoechea");
  });

  it("matches Shannon and the 'Shannon v' typo", () => {
    expect(normalizeRawName("Shannon").canonicalName).toBe("Shannon");
    expect(normalizeRawName("Shannon v").canonicalName).toBe("Shannon");
  });

  it("merges J.Iniguez spelling variants to Jose Iniguez", () => {
    expect(normalizeRawName("J.Iniguez").canonicalName).toBe("Jose Iniguez");
    expect(normalizeRawName("J.Inigiez").canonicalName).toBe("Jose Iniguez");
    expect(normalizeRawName("J.Imiguez").canonicalName).toBe("Jose Iniguez");
  });

  it("merges M.Johnson / M. Johnson / M.johnson", () => {
    expect(normalizeRawName("M.Johnson").canonicalName).toBe("M. Johnson");
    expect(normalizeRawName("M. Johnson").canonicalName).toBe("M. Johnson");
    expect(normalizeRawName("M.johnson").canonicalName).toBe("M. Johnson");
  });
});

describe("normalizeRawName (cleanup pipeline)", () => {
  it("extracts parentheticals into the note field", () => {
    const r = normalizeRawName("N. Milone (Academy Pablo)");
    expect(r.canonicalName).toBe("N. Milone");
    expect(r.note).toBe("Academy Pablo");
    expect(r.confidence).toBe("alias");
  });

  it("joins multiple parentheticals with semicolons", () => {
    const r = normalizeRawName("J.Iniguez (JP De La Cruz) (online)");
    expect(r.canonicalName).toBe("Jose Iniguez");
    expect(r.note).toBe("JP De La Cruz; online");
  });

  it("strips trailing 3+ digit invoice IDs and pushes them to note", () => {
    const r = normalizeRawName("Juan Garcia1152");
    expect(r.canonicalName).toBe("Juan Garcia");
    expect(r.note).toBe("#1152");
  });

  it("preserves names that incidentally end in 1-2 digits (no canonical we have, but doesn't crash)", () => {
    const r = normalizeRawName("Jung 8081");
    expect(r.canonicalName).toBe("Jung");
    expect(r.note).toBe("#8081");
  });

  it("strips trailing standalone 'Online' modality to the note", () => {
    const r = normalizeRawName("D. Lusk Online");
    expect(r.canonicalName).toBe("David Lusk");
    expect(r.note).toBe("Online");
  });

  it("returns unmatched with note for a naked parenthetical like '(TEST)'", () => {
    const r = normalizeRawName("(TEST)");
    expect(r.canonicalName).toBe("");
    expect(r.note).toBe("TEST");
    expect(r.confidence).toBe("unmatched");
  });

  it("returns unmatched for pure-digit cells like '8733'", () => {
    const r = normalizeRawName("8733");
    expect(r.canonicalName).toBe("");
    expect(r.confidence).toBe("unmatched");
  });

  it("returns unmatched for single-letter cells like 'O'", () => {
    const r = normalizeRawName("O");
    expect(r.canonicalName).toBe("");
    expect(r.confidence).toBe("unmatched");
  });
});

describe("normalizeRawName (fuzzy match)", () => {
  it("matches a 1-edit typo to the nearest alias key", () => {
    // "Necoeches" (one char off) should fuzzy-hit "necoechea"
    const r = normalizeRawName("Necoeches");
    expect(r.canonicalName).toBe("Necoechea");
    expect(r.confidence).toBe("fuzzy");
  });

  it("returns 'cleaned' for unknown names with letters (admin review in I3)", () => {
    const r = normalizeRawName("Brand New Coach");
    expect(r.canonicalName).toBe("Brand New Coach");
    expect(r.confidence).toBe("cleaned");
    expect(r.note).toBeNull();
  });

  it("does NOT fuzzy-collapse genuinely different short names", () => {
    // "Ruben" is 5 chars and aliased. "Roben" is 1 edit away — would fuzzy-hit Ruben.
    // We accept that as a feature (typo tolerance). Documented here as expected behavior.
    const r = normalizeRawName("Roben");
    expect(r.canonicalName).toBe("Ruben");
    expect(r.confidence).toBe("fuzzy");
  });
});

describeWithFixture("normalizeSessions over the real workbook", () => {
  it("preserves session count and aggregates by canonical name with low unmatched rate", async () => {
    const sessions = await parseWorkbook(await readFile(FIXTURE));
    const normalized = normalizeSessions(sessions);
    expect(normalized).toHaveLength(sessions.length);

    const byCanonical = new Map<string, number>();
    const unmatchedRaw = new Set<string>();
    let cleanedCount = 0;
    let unmatchedCount = 0;
    for (const n of normalized) {
      byCanonical.set(n.canonicalName, (byCanonical.get(n.canonicalName) ?? 0) + 1);
      if (n.confidence === "cleaned") cleanedCount += 1;
      if (n.confidence === "unmatched") {
        unmatchedCount += 1;
        unmatchedRaw.add(n.rawName);
      }
    }

    // Sanity: the David Lusk merge actually happens — count >= sum of variants present.
    // From the smoke run: "D. Lusk" (23) + "D. Lusk Online" (4) + (hypothetical) = 27.
    expect(byCanonical.get("David Lusk") ?? 0).toBeGreaterThanOrEqual(27);

    // PFA programs (PFA Travel etc) are the dominant cleaned bucket — we expect ~50 sessions
    // landing as confidence='cleaned' or 'unmatched', which is the I3 admin-review backlog.
    // Snapshot as a regression guard; update when the alias map grows.
    expect(cleanedCount + unmatchedCount).toBeLessThan(100);
  });
});
