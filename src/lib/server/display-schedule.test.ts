// Unit tests for `resolveDisplayBlockLabel` — the ONE rule that decides what
// text a red bar on the public facility TV prints.
//
// 🔴 WHY THIS RULE GETS ITS OWN FILE. Since 2026-10-13 the display query
// SELECTS `blocked_times.reason`, a free-text field, and this function is the
// only thing deciding whether that text is printed. Two kinds of row carry a
// `reason` and they must be treated oppositely:
//
//   · HAND-ENTERED (no programScheduleBlockId) — the note is what the facility
//     owner typed and asked to see on the wall. Print it.
//   · PROGRAM-MADE (programScheduleBlockId set)  — the "reason" is the auto
//     text `Program: <name>`. Never print it; print the program's short name.
//
// The integration suite (tests/integration/display-schedule.test.ts) proves
// the rule against real rows. This file pins every branch without a network
// round trip, including the one no real row can reach: a program-made row with
// no program names.

import { describe, expect, it, vi } from "vitest";

// `display-schedule.ts` imports `@/db`, which throws at import without
// DATABASE_URL. The double throws on ANY use, so a passing test here is also
// proof that resolving a label never touches the database.
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`label resolution touched the database: db.${String(prop)}`);
      },
    },
  ),
}));

import {
  DISPLAY_BLOCKED_LABEL,
  resolveDisplayBlockLabel,
} from "./display-schedule";

type LabelRow = Parameters<typeof resolveDisplayBlockLabel>[0];

/** A hand-entered block with nothing set — every test overrides what it means. */
function handEntered(overrides: Partial<LabelRow> = {}): LabelRow {
  return {
    programScheduleBlockId: null,
    reason: "",
    programName: null,
    programDisplayName: null,
    tagName: null,
    tagDisplayName: null,
    ...overrides,
  };
}

/** A block a scheduled program owns, carrying the auto `Program: …` reason. */
function programMade(overrides: Partial<LabelRow> = {}): LabelRow {
  return {
    programScheduleBlockId: "psb-1",
    reason: "Program: Softball Travel Ball",
    programName: "Softball Travel Ball",
    programDisplayName: "SB - Travelball",
    tagName: null,
    tagDisplayName: null,
    ...overrides,
  };
}

describe("a HAND-ENTERED block prints the note that was typed", () => {
  it("shows the note exactly", () => {
    expect(resolveDisplayBlockLabel(handEntered({ reason: "TRAVEL PRACTICE" }))).toBe(
      "TRAVEL PRACTICE",
    );
    // The owner's own habit: a first name plus the last four digits of a
    // phone number. It is printed as typed.
    expect(resolveDisplayBlockLabel(handEntered({ reason: "Mia 4821" }))).toBe(
      "Mia 4821",
    );
  });

  it("returns the note's characters untouched — escaping is the renderer's job", () => {
    // React escapes text children. This function must not pre-escape, strip
    // or otherwise rewrite the note, or the wall would print `&lt;b&gt;`.
    const note = '<b>x</b> & "q"';
    expect(resolveDisplayBlockLabel(handEntered({ reason: note }))).toBe(note);
  });

  it("trims the note, and only its ends", () => {
    expect(
      resolveDisplayBlockLabel(handEntered({ reason: "  \tTRAVEL  PRACTICE \n" })),
    ).toBe("TRAVEL  PRACTICE");
  });

  it("🔴 the note outranks a program tag set on the same block", () => {
    // The owner's complaint was that "SB - Travelball" tells her coaches
    // nothing. If she typed a note, the note is the answer.
    expect(
      resolveDisplayBlockLabel(
        handEntered({
          reason: "TRAVEL PRACTICE",
          tagName: "Softball Travel Ball",
          tagDisplayName: "SB - Travelball",
        }),
      ),
    ).toBe("TRAVEL PRACTICE");
  });

  it("a whitespace-only note falls back to the tag's short name", () => {
    expect(
      resolveDisplayBlockLabel(
        handEntered({
          reason: "   ",
          tagName: "Softball Travel Ball",
          tagDisplayName: "SB - Travelball",
        }),
      ),
    ).toBe("SB - Travelball");
  });

  it("...then to the tag's full name when it has no short form", () => {
    expect(
      resolveDisplayBlockLabel(
        handEntered({ reason: " \t ", tagName: "Softball Travel Ball" }),
      ),
    ).toBe("Softball Travel Ball");
  });

  it("...then to the generic label when there is no tag either", () => {
    // An outlined bar with no text in it reads as a free cage from across the
    // room (see BLOCKED_OUTLINE in display-grid.tsx).
    expect(resolveDisplayBlockLabel(handEntered({ reason: "   " }))).toBe(
      DISPLAY_BLOCKED_LABEL,
    );
    expect(resolveDisplayBlockLabel(handEntered({ reason: "" }))).toBe(
      DISPLAY_BLOCKED_LABEL,
    );
  });

  it("📌 a tag whose short name is an empty string still prints as empty (`??`, not `||`)", () => {
    // The one way a hand-entered bar can still come out with no text: no
    // note, and a tag whose `displayName` is "". Same choice as the program
    // chain makes — an empty short name is a data problem worth seeing on the
    // wall, not one to paper over — and the reason DISPLAY_BLOCKED_LABEL's
    // doc does not promise a bar is never empty.
    expect(
      resolveDisplayBlockLabel(
        handEntered({ reason: "  ", tagName: "Camp", tagDisplayName: "" }),
      ),
    ).toBe("");
  });
});

describe("a note with nothing VISIBLE in it counts as blank", () => {
  // `String.prototype.trim` strips whitespace and U+FEFF, but not the other
  // zero-width characters — and a bar whose label is one of those renders with
  // no text in it. All of them are written as escapes here on purpose: a
  // literal one in this file would be invisible in review.
  const ZERO_WIDTH_SPACE = "\u200B";
  const ZERO_WIDTH_NON_JOINER = "\u200C";
  const ZERO_WIDTH_JOINER = "\u200D";
  const WORD_JOINER = "\u2060";
  const ZERO_WIDTH_NO_BREAK_SPACE = "\uFEFF";
  const EACH = [
    ZERO_WIDTH_SPACE,
    ZERO_WIDTH_NON_JOINER,
    ZERO_WIDTH_JOINER,
    WORD_JOINER,
    ZERO_WIDTH_NO_BREAK_SPACE,
  ];

  it("each zero-width character on its own falls to the generic label", () => {
    for (const ch of EACH) {
      expect(
        resolveDisplayBlockLabel(handEntered({ reason: ch })),
        `U+${ch.codePointAt(0)?.toString(16).toUpperCase()}`,
      ).toBe(DISPLAY_BLOCKED_LABEL);
    }
  });

  it("a note of only zero-width characters and spaces falls to the tag, then 'Blocked'", () => {
    const invisible = ` ${EACH.join(" ")} \t`;
    expect(
      resolveDisplayBlockLabel(
        handEntered({
          reason: invisible,
          tagName: "Softball Travel Ball",
          tagDisplayName: "SB - Travelball",
        }),
      ),
    ).toBe("SB - Travelball");
    expect(
      resolveDisplayBlockLabel(
        handEntered({ reason: invisible, tagName: "Softball Travel Ball" }),
      ),
    ).toBe("Softball Travel Ball");
    expect(resolveDisplayBlockLabel(handEntered({ reason: invisible }))).toBe(
      DISPLAY_BLOCKED_LABEL,
    );
  });

  // Everything Unicode marks Default_Ignorable_Code_Point — the characters a
  // renderer is told to show as nothing. Built from code points, never typed,
  // so each one can be read here.
  const DEFAULT_IGNORABLE: [number, string][] = [
    [0x00ad, "soft hyphen"],
    [0x034f, "combining grapheme joiner"],
    [0x061c, "Arabic letter mark"],
    [0x115f, "Hangul choseong filler"],
    [0x1160, "Hangul jungseong filler"],
    [0x180e, "Mongolian vowel separator"],
    [0x200e, "left-to-right mark"],
    [0x200f, "right-to-left mark"],
    [0x202a, "left-to-right embedding"],
    [0x202b, "right-to-left embedding"],
    [0x202c, "pop directional formatting"],
    [0x202d, "left-to-right override"],
    [0x202e, "right-to-left override"],
    [0x2061, "function application"],
    [0x2066, "left-to-right isolate"],
    [0x2067, "right-to-left isolate"],
    [0x2068, "first strong isolate"],
    [0x2069, "pop directional isolate"],
    [0x3164, "Hangul filler"],
    [0xfe0f, "variation selector-16"],
    [0xffa0, "halfwidth Hangul filler"],
    [0xe0020, "tag space (outside the BMP)"],
  ];
  const cp = (n: number) => `U+${n.toString(16).toUpperCase().padStart(4, "0")}`;

  it("each default-ignorable character on its own falls to the generic label", () => {
    for (const [code, name] of DEFAULT_IGNORABLE) {
      expect(
        resolveDisplayBlockLabel(handEntered({ reason: String.fromCodePoint(code) })),
        `${cp(code)} ${name}`,
      ).toBe(DISPLAY_BLOCKED_LABEL);
    }
  });

  it("a note of only such characters and spaces falls to the tag", () => {
    const invisible = ` ${DEFAULT_IGNORABLE.map(([code]) => String.fromCodePoint(code)).join(" ")} `;
    expect(
      resolveDisplayBlockLabel(
        handEntered({ reason: invisible, tagName: "Softball Travel Ball", tagDisplayName: "SB - Travelball" }),
      ),
    ).toBe("SB - Travelball");
  });

  it("🔴 a real note that contains one of them is printed as typed, character for character", () => {
    // They decide only whether there is anything to print. Each of these is a
    // normal thing to find inside real text.
    const baseball = `${String.fromCodePoint(0x26be, 0xfe0f)} practice`; // emoji + variation selector
    const softHyphen = `Travel${String.fromCodePoint(0x00ad)}ball`;
    const rtlMark = `Mia${String.fromCodePoint(0x200f)} 4821`;
    for (const real of [baseball, softHyphen, rtlMark]) {
      const label = resolveDisplayBlockLabel(handEntered({ reason: `  ${real}  ` }));
      expect(label).toBe(real);
      expect(label.length, "nothing was removed from the note").toBe(real.length);
    }
  });

  it("📌 known gap: a blank-LOOKING character Unicode does not mark ignorable is printed", () => {
    // The check is "Default_Ignorable_Code_Point or whitespace", not "renders
    // as nothing". U+2800 BRAILLE PATTERN BLANK is an ordinary symbol to
    // Unicode and an empty box to the eye, so a note made only of it prints a
    // bar with no visible text. Pinned so the constant's doc cannot claim more
    // than this.
    const brailleBlank = String.fromCodePoint(0x2800);
    expect(resolveDisplayBlockLabel(handEntered({ reason: brailleBlank }))).toBe(brailleBlank);
  });

  it("🔴 a real note that CONTAINS a zero-width character is printed as typed", () => {
    // Those characters are only used to decide whether there is anything to
    // print. They are never removed from a note that has visible text: a
    // zero-width joiner is what holds some emoji and some scripts together.
    const joined = `Mia${ZERO_WIDTH_JOINER} 4821`;
    expect(resolveDisplayBlockLabel(handEntered({ reason: joined }))).toBe(joined);

    const family = `\u{1F468}${ZERO_WIDTH_JOINER}\u{1F469}${ZERO_WIDTH_JOINER}\u{1F467} party`;
    expect(resolveDisplayBlockLabel(handEntered({ reason: `  ${family}  ` }))).toBe(family);

    const leading = `${ZERO_WIDTH_SPACE}TRAVEL PRACTICE${WORD_JOINER}`;
    expect(resolveDisplayBlockLabel(handEntered({ reason: leading }))).toBe(leading);
  });
});

describe("🔴 a PROGRAM-MADE block never prints its reason", () => {
  it("shows the program's short name even though a reason is set", () => {
    expect(resolveDisplayBlockLabel(programMade())).toBe("SB - Travelball");
  });

  it("shows the full program name when there is no short form", () => {
    expect(resolveDisplayBlockLabel(programMade({ programDisplayName: null }))).toBe(
      "Softball Travel Ball",
    );
  });

  it("real occupancy outranks a tag set on the same row", () => {
    expect(
      resolveDisplayBlockLabel(
        programMade({ tagName: "Tag That Must Lose", tagDisplayName: "TAG LOSES" }),
      ),
    ).toBe("SB - Travelball");
  });

  it("with no program names it falls through to the tag, then the generic label — NOT the reason", () => {
    // Not reachable through the app today (`programs.name` is NOT NULL and the
    // link is a foreign key), which is exactly why it is pinned here: the
    // fall-through is the one place a careless edit would reach for `reason`.
    const orphan = { programName: null, programDisplayName: null };
    expect(
      resolveDisplayBlockLabel(
        programMade({ ...orphan, tagName: "Camp", tagDisplayName: "Camp Short" }),
      ),
    ).toBe("Camp Short");
    expect(resolveDisplayBlockLabel(programMade({ ...orphan, tagName: "Camp" }))).toBe(
      "Camp",
    );
    expect(resolveDisplayBlockLabel(programMade(orphan))).toBe(DISPLAY_BLOCKED_LABEL);
  });

  it("a hand-typed-looking reason on a program-made row is still not printed", () => {
    // The discriminator is the LINK, not what the text looks like. A reason
    // that does not start with "Program:" is withheld all the same.
    expect(
      resolveDisplayBlockLabel(programMade({ reason: "Tyler makeup lesson" })),
    ).toBe("SB - Travelball");
  });

  it("🔴 fails closed: a row with no link column at all is treated as program-made", () => {
    // Cannot happen through the typed query, which is the point of pinning
    // it: the test in the rule is `!== null`, so anything other than an
    // explicit NULL withholds the reason.
    const noColumn = handEntered({
      reason: "TRAVEL PRACTICE",
      programScheduleBlockId: undefined as unknown as null,
    });
    expect(resolveDisplayBlockLabel(noColumn)).toBe(DISPLAY_BLOCKED_LABEL);
  });

  it("keeps an empty-string short name rather than skipping it (`??`, not `||`)", () => {
    // Unchanged from before this rule existed: an empty short name is a data
    // problem worth seeing on the wall, not one to paper over.
    expect(resolveDisplayBlockLabel(programMade({ programDisplayName: "" }))).toBe("");
  });
});
