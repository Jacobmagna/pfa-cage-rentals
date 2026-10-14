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

  it("...then to the generic label, never to an empty bar", () => {
    // An outlined bar with no text in it reads as a free cage from across the
    // room (see BLOCKED_OUTLINE in display-grid.tsx).
    expect(resolveDisplayBlockLabel(handEntered({ reason: "   " }))).toBe(
      DISPLAY_BLOCKED_LABEL,
    );
    expect(resolveDisplayBlockLabel(handEntered({ reason: "" }))).toBe(
      DISPLAY_BLOCKED_LABEL,
    );
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
    // The same holds for the tag a hand-entered block falls back to when it
    // has no note to print.
    expect(
      resolveDisplayBlockLabel(
        handEntered({ reason: "  ", tagName: "Camp", tagDisplayName: "" }),
      ),
    ).toBe("");
  });
});
