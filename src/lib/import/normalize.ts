import type { RawSession } from "./parse";

export type NameConfidence = "alias" | "fuzzy" | "cleaned" | "unmatched";

export type NormalizedName = {
  canonicalName: string;
  note: string | null;
  confidence: NameConfidence;
  rawName: string;
};

export type NormalizedSession = RawSession & Omit<NormalizedName, "rawName">;

// Seed alias map. Keys are the cleaned lowercase form (after parens/Online/trailing-digit
// stripping). BRAINSTORM.md:48-58 plus deterministic typos / formatting variants observed
// in source_data.xlsx. Programs like "PFA Travel" deliberately omitted — admins resolve
// those in I3's import-review UI.
export const ALIAS_MAP: Record<string, string> = {
  // David Lusk
  "d. lusk": "David Lusk",
  "lusk": "David Lusk",
  "david lusk": "David Lusk",
  "david": "David Lusk",

  // Jose Iniguez
  "j.iniguez": "Jose Iniguez",
  "j. iniguez": "Jose Iniguez",
  "j.inigiez": "Jose Iniguez",
  "j.imiguez": "Jose Iniguez",
  "jose iniguez": "Jose Iniguez",

  // Necoechea
  "necoechea": "Necoechea",
  "d.necochea": "Necoechea",

  // Shannon
  "shannon": "Shannon",
  "shannon v": "Shannon",

  // Juan Garcia
  "juan garcia": "Juan Garcia",

  // J. Tyler — note: "Tyler (Member)" deliberately NOT mapped; BRAINSTORM flags it as
  // possibly a different person. Admin reviews via I3.
  "j. tyler": "J. Tyler",
  "j.tyler": "J. Tyler",

  // N. Milone
  "n. milone": "N. Milone",
  "n.milone": "N. Milone",

  // A. Milone
  "a. milone": "A. Milone",
  "a.milone": "A. Milone",

  // L. Milone
  "l. milone": "L. Milone",
  "l.milone": "L. Milone",
  "l milone": "L. Milone",

  // M. Johnson
  "m. johnson": "M. Johnson",
  "m.johnson": "M. Johnson",

  // Others observed in source_data.xlsx with clear identity
  "jamie leon": "Jamie Leon",
  "jaime leon": "Jamie Leon",
  "j.leon": "Jamie Leon",
  "morey": "Morey",
  "morrey": "Morey",
  "b. homer": "B. Homer",
  "b.homer": "B. Homer",
  "b. bohning": "B. Bohning",
  "b.bohning": "B. Bohning",
  "n. ramirez": "N. Ramirez",
  "n.ramirez": "N. Ramirez",
  "c.fry": "C. Fry",
  "c. fry": "C. Fry",
  "c. parker": "Cole Parker",
  "cole parker": "Cole Parker",
  "cesar hernandez": "Cesar Hernandez",
  "tyler knox": "Tyler Knox",
  "ruben": "Ruben",
  "j hartman": "J. Hartman",
  "j. hartman": "J. Hartman",
  "j.hartman": "J. Hartman",
  "allen fischer": "Allen Fischer",
  "m. garcia": "M. Garcia",
  "m.garcia": "M. Garcia",
  "s. marsten": "S. Marsten",
  "s.marsten": "S. Marsten",
  "mark wendell": "Mark Wendell",
  "fabian arroyo": "Fabian Arroyo",
  "jung": "Jung",
  "jayden lusk": "Jayden Lusk",
};

export function normalizeRawName(raw: string): NormalizedName {
  const notes: string[] = [];

  // 1. Extract parentheticals → notes
  let cleaned = raw.replace(/\s*\(([^)]*)\)\s*/g, (_m, inner: string) => {
    const trimmed = inner.trim();
    if (trimmed.length > 0) notes.push(trimmed);
    return " ";
  });

  // 2. Strip trailing modality keywords (whole-word "online" / "Online")
  cleaned = cleaned.replace(/\s+online\s*$/i, () => {
    notes.push("Online");
    return "";
  });

  // 3. Strip trailing digit-runs of length ≥3 (invoice / student IDs)
  cleaned = cleaned.replace(/\s*(\d{3,})\s*$/, (_m, digits: string) => {
    notes.push(`#${digits}`);
    return "";
  });

  // 4. Collapse whitespace + trim
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  const note = notes.length > 0 ? notes.join("; ") : null;

  // 5. Empty after cleanup (e.g. raw was "(TEST)") → unmatched
  if (cleaned === "") {
    return { canonicalName: "", note, confidence: "unmatched", rawName: raw };
  }

  // 6. Alias lookup (case-insensitive)
  const key = cleaned.toLowerCase();
  const aliasHit = ALIAS_MAP[key];
  if (aliasHit) {
    return { canonicalName: aliasHit, note, confidence: "alias", rawName: raw };
  }

  // 7. Fuzzy: Levenshtein-1 against alias keys for inputs of length ≥5
  if (cleaned.length >= 5) {
    for (const aliasKey of Object.keys(ALIAS_MAP)) {
      if (Math.abs(aliasKey.length - key.length) > 1) continue;
      if (levenshtein(key, aliasKey) <= 1) {
        return { canonicalName: ALIAS_MAP[aliasKey], note, confidence: "fuzzy", rawName: raw };
      }
    }
  }

  // 8. Strings with no letters at all are junk
  if (!/[a-z]/i.test(cleaned)) {
    return { canonicalName: "", note: note ?? cleaned, confidence: "unmatched", rawName: raw };
  }

  // 9. Single letter → unmatched (likely typo / stray cell)
  if (cleaned.length === 1) {
    return { canonicalName: "", note: note ?? cleaned, confidence: "unmatched", rawName: raw };
  }

  // 10. Fallback: return title-cased cleaned form, flagged for admin review
  return { canonicalName: titleCase(cleaned), note, confidence: "cleaned", rawName: raw };
}

export function normalizeSessions(sessions: RawSession[]): NormalizedSession[] {
  return sessions.map((s) => {
    const { canonicalName, note, confidence } = normalizeRawName(s.rawName);
    return { ...s, canonicalName, note, confidence };
  });
}

function titleCase(s: string): string {
  return s
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part) || part.length === 0) return part;
      return part[0].toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  let prev = new Array<number>(bLen + 1);
  let curr = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j++) prev[j] = j;

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i;
    for (let j = 1; j <= bLen; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bLen];
}
