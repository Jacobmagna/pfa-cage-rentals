// What the TV grid actually WRITES INTO THE PAGE for a block's label.
//
// 🔴 WHY THIS EXISTS. Since 2026-10-13 a hand-entered block's label is text an
// admin typed (see the header of src/lib/server/display-schedule.ts). The
// tests on that module assert what `fetchDisplaySchedule` RETURNS; none of
// them reads markup. This one renders the real `DisplayGrid` and reads the
// HTML, because the two ways a typed note could do harm here both live in the
// markup and nowhere else:
//
//   · printed as HTML instead of text — a note of `<b>x</b>` becoming an
//     element;
//   · copied into an attribute (`title`, `aria-label`, `alt`) — invisible on a
//     wall with no mouse, fully readable in View Source, and exactly what
//     `/master/schedule` does with a session's note.
//
// Rendered with `renderToStaticMarkup`, as the statement tests are: this
// suite runs in `environment: "node"` with no jsdom, and `DisplayGrid` is a
// plain function of its props — no hooks, no data fetching — so it needs no
// mocks. (`display-schedule.ts` is imported for TYPES only, which is why
// nothing here touches the database module.)
//
// ── How to see it RED ────────────────────────────────────────────────────────
// In display-grid.tsx's `Bar`, add `title={label}` to the label <span>: the
// note is then in the page twice and in an attribute. Or replace the span's
// `{label}` child with `dangerouslySetInnerHTML={{ __html: label }}`: the note
// becomes a real <b> element.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DisplayWindow } from "@/lib/display/window";
import type {
  DisplayBlock,
  DisplayResource,
  DisplaySession,
} from "@/lib/server/display-schedule";
import { DisplayGrid } from "./display-grid";

/** 1:30 PM – 4:30 PM Pacific on a summer day: six 30-minute slots. */
const WINDOW_START = new Date("2037-06-10T20:30:00.000Z");
const SLOT_MS = 30 * 60_000;
const WIN: DisplayWindow = {
  startAt: WINDOW_START,
  endAt: new Date(WINDOW_START.getTime() + 6 * SLOT_MS),
  slotCount: 6,
};
const slot = (i: number) => new Date(WINDOW_START.getTime() + i * SLOT_MS);

const RESOURCES: DisplayResource[] = [
  { id: "res-cage", name: "Cage 1", type: "cage", sortOrder: 1 },
  { id: "res-bullpen", name: "Bullpen 1", type: "bullpen", sortOrder: 2 },
];

/** Markup, an ampersand and quotes: everything that needs escaping, in one note. */
const MARKUP_NOTE = '<b>x</b> & "q"';
const COACH_LABEL = "Coach Rivera";

function block(label: string): DisplayBlock {
  return { id: "block-1", resourceId: "res-cage", startAt: slot(1), endAt: slot(3), label };
}
function session(coachLabel: string): DisplaySession {
  return {
    id: "session-1",
    resourceId: "res-bullpen",
    startAt: slot(1),
    endAt: slot(3),
    coachLabel,
    isGroupSession: false,
  };
}

function render(blocks: DisplayBlock[], sessions: DisplaySession[]): string {
  return renderToStaticMarkup(
    createElement(DisplayGrid, {
      win: WIN,
      resources: RESOURCES,
      sessions,
      blocks,
      now: slot(2),
    }),
  );
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Every text node in the markup, entity-decoded. Anchored on TEXT, never on a
 * class string (maintenance rule 11), and it throws rather than returning an
 * empty list — an empty list would make every "is absent" check below pass.
 */
function textNodes(html: string): string[] {
  const out = [...html.matchAll(/>([^<>]+)</g)].map((m) => decode(m[1]));
  if (out.length === 0) {
    throw new Error("textNodes: the grid rendered no text at all — nothing to assert on");
  }
  return out;
}

/** Every attribute on every element, value entity-decoded. Throws on no elements. */
function attributes(html: string): { name: string; value: string }[] {
  const tags = html.match(/<[a-zA-Z][^>]*>/g);
  if (!tags || tags.length === 0) {
    throw new Error("attributes: the grid rendered no elements at all");
  }
  return tags.flatMap((tag) =>
    [...tag.matchAll(/\s([a-zA-Z_:][-\w:.]*)="([^"]*)"/g)].map((m) => ({
      name: m[1],
      value: decode(m[2]),
    })),
  );
}

const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe("a block's label reaches the page as TEXT, once, and nowhere else", () => {
  const html = render([block(MARKUP_NOTE)], [session(COACH_LABEL)]);

  it("the grid really rendered — the controls every check below leans on", () => {
    const texts = textNodes(html);
    expect(texts).toContain("Cage 1");
    expect(texts).toContain("Bullpen 1");
    expect(texts).toContain(COACH_LABEL);
    // The grid has styling attributes, so "no attribute carries the note" is
    // not passing because there are no attributes to look through.
    expect(attributes(html).some((a) => a.name === "style")).toBe(true);
  });

  it("🔴 the note is printed literally, as exactly one text node", () => {
    expect(textNodes(html).filter((t) => t === MARKUP_NOTE)).toHaveLength(1);
    // And only once in the whole document, counted on a fragment that is the
    // same whether React escaped it as text or as an attribute value.
    expect(occurrences(html, "&lt;b&gt;x&lt;/b&gt;")).toBe(1);
  });

  it("🔴 the note does not become markup", () => {
    expect(html).not.toMatch(/<b[\s>]/);
    expect(html).not.toContain("<b>x</b>");
    // Control for the two lines above: the escaped form IS there.
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("🔴 no attribute carries the note — and the grid has no title, aria-label or alt at all", () => {
    const attrs = attributes(html);
    expect(attrs.filter((a) => a.value.includes("x</b>"))).toEqual([]);
    expect(attrs.filter((a) => a.value.includes(MARKUP_NOTE))).toEqual([]);
    expect(
      attrs.filter((a) => ["title", "aria-label", "alt"].includes(a.name)).map((a) => a.name),
    ).toEqual([]);
  });

  it("the session's coach label is text too, once, and in no attribute", () => {
    expect(textNodes(html).filter((t) => t === COACH_LABEL)).toHaveLength(1);
    expect(occurrences(html, COACH_LABEL)).toBe(1);
    expect(attributes(html).filter((a) => a.value.includes(COACH_LABEL))).toEqual([]);
  });
});

describe("a label is printed whole into the page, whatever the bar can show", () => {
  it("📌 a long note is not shortened in the markup — the cut-off on the wall is CSS only", () => {
    // Pinned because it is the difference between what the wall shows and
    // what someone holding the display link can read: the bar truncates with
    // an ellipsis on screen, the page source carries the entire note.
    const long = "TRAVEL PRACTICE 14U GOLD WITH COACH RIVERA FIELD 2 BRING HELMETS";
    const out = render(
      [{ id: "block-long", resourceId: "res-cage", startAt: slot(3), endAt: slot(4), label: long }],
      [],
    );
    expect(textNodes(out).filter((t) => t === long)).toHaveLength(1);
    expect(occurrences(out, long)).toBe(1);
  });
});
