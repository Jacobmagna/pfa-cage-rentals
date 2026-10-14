// What the two coach calendar panels render for a weight room, and that a
// cage still renders as it did. Static render of the panel as it OPENS
// (no clicks); the server actions are stubbed because nothing is sent.
//
// Every text assertion is scoped to the element it is about: the alert box,
// a button, the duration group, or one review-list paragraph.

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../../actions", () => ({
  logOwnSession: vi.fn(),
  logOwnSessionsBatch: vi.fn(),
}));

import { CageSlotBooking } from "./cage-slot-booking";
import { CageBatchBooking } from "./cage-batch-booking";
import type { ResourceOption } from "../../_components/types";
import type { SlotState } from "@/lib/coach-calendar";
import { pfaDayStart, pfaWallClockToUtc } from "@/lib/timezone";

const WR: ResourceOption = { id: "wr-1", name: "Weight Room 1", type: "weight_room" };
const CAGE: ResourceOption = { id: "cage-1", name: "Cage 1", type: "cage" };
const RESOURCES = [CAGE, WR];

const DAY = "2026-10-17";
const SELECTED_DATE = pfaDayStart(pfaWallClockToUtc(DAY, "12:00"));
// 3:00 PM on the grid (slot 0 = 8:00 AM).
const S3PM = 14;

function decode(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function textOf(fragment: string): string {
  return decode(fragment.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Each role="alert" box, as the text of its paragraphs (or its own text). */
function alerts(html: string): string[][] {
  return [...html.matchAll(/<div role="alert"[^>]*>([\s\S]*?)<\/div>/g)].map(
    (m) => {
      const ps = [...m[1].matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((p) =>
        textOf(p[1]),
      );
      return ps.length > 0 ? ps : [textOf(m[1])];
    },
  );
}

type Button = { text: string; disabled: boolean; pressed: string | null };

function buttons(html: string): Button[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(
    (m) => ({
      text: textOf(m[2]),
      disabled: /\sdisabled=""/.test(m[1]),
      pressed: /aria-pressed="([^"]*)"/.exec(m[1])?.[1] ?? null,
    }),
  );
}

/** The buttons inside the "Rental duration" group, or null if no group. */
function durationButtons(html: string): Button[] | null {
  const m = /<div role="group" aria-label="Rental duration"[^>]*>([\s\S]*?)<\/div>/.exec(
    html,
  );
  return m ? buttons(m[1]) : null;
}

/** The batch panel's small title (the first paragraph, "Book N …"). */
function header(html: string): string | undefined {
  return paragraphs(html)[0];
}

function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) => textOf(m[1]));
}

function oneTap(
  resource: ResourceOption,
  maxDurationMin: number,
  facts: { prevSlotFree: boolean; nextToOwnRental: boolean } = {
    prevSlotFree: false,
    nextToOwnRental: false,
  },
): string {
  return renderToStaticMarkup(
    createElement(CageSlotBooking, {
      resource,
      selectedDate: SELECTED_DATE,
      slotIndex: S3PM,
      maxDurationMin,
      ...facts,
      onBooked: () => {},
      onCancel: () => {},
    }),
  );
}

function batch(
  keys: string[],
  slotState: (resourceId: string, slotIndex: number) => SlotState = () =>
    "free",
): string {
  return renderToStaticMarkup(
    createElement(CageBatchBooking, {
      resources: RESOURCES,
      selection: new Set(keys),
      displayedDate: DAY,
      slotStateOnDisplayedDay: slotState,
      onBooked: () => {},
      onCancel: () => {},
    }),
  );
}

const key = (resource: ResourceOption, slotIndex: number) =>
  `${DAY}|${resource.id}|${slotIndex}`;

describe("one-tap panel, weight room", () => {
  it("only 30 minutes free: refusal shown, no duration control, no Book button", () => {
    const html = oneTap(WR, 30, { prevSlotFree: true, nextToOwnRental: false });
    expect(alerts(html)).toEqual([
      [
        "Weight room rentals are one hour minimum, and only 30 minutes is free from 3:00 PM on Weight Room 1.",
        "Tap 2:30 PM instead to book 2:30 PM – 3:30 PM.",
      ],
    ]);
    expect(durationButtons(html)).toBeNull();
    const labels = buttons(html).map((b) => b.text);
    expect(labels).not.toContain("Book this slot");
    expect(labels).toContain("Cancel");
  });

  it("only 30 minutes free, next to the coach's own rental", () => {
    const html = oneTap(WR, 30, { prevSlotFree: false, nextToOwnRental: true });
    expect(alerts(html)).toEqual([
      [
        "Weight room rentals are one hour minimum, and only 30 minutes is free from 3:00 PM on Weight Room 1.",
        "It sits next to your own rental. If that rental hasn't started yet, you can make it longer on My rentals.",
      ],
    ]);
  });

  it("nothing free from the tapped slot (a refresh showed it taken): says so, no Book button", () => {
    const html = oneTap(WR, 0, { prevSlotFree: true, nextToOwnRental: true });
    expect(alerts(html)).toEqual([
      ["3:00 PM on Weight Room 1 is no longer free.", "Pick another time."],
    ]);
    expect(durationButtons(html)).toBeNull();
    const labels = buttons(html).map((b) => b.text);
    expect(labels).not.toContain("Book this slot");
    expect(labels).toContain("Cancel");
  });

  it("two hours free: opens at 1 hr, no 30 min choice, no split, no group checkbox", () => {
    const html = oneTap(WR, 120);
    expect(alerts(html)).toEqual([]);
    expect(paragraphs(html)).toContain("3:00 PM – 4:00 PM");
    expect(durationButtons(html)).toEqual([
      { text: "1 hr", disabled: false, pressed: "true" },
      { text: "Custom", disabled: false, pressed: "false" },
    ]);
    expect(html).not.toContain("Book as separate 30-minute rentals");
    expect(html).not.toContain("Group session");
    const book = buttons(html).find((b) => b.text === "Book this slot");
    expect(book).toEqual({ text: "Book this slot", disabled: false, pressed: null });
  });
});

describe("one-tap panel, cage (unchanged)", () => {
  it("opens at 30 min with 30 min / 1 hr / Custom", () => {
    const html = oneTap(CAGE, 120);
    expect(alerts(html)).toEqual([]);
    expect(paragraphs(html)).toContain("3:00 PM – 3:30 PM");
    expect(durationButtons(html)).toEqual([
      { text: "30 min", disabled: false, pressed: "true" },
      { text: "1 hr", disabled: false, pressed: "false" },
      { text: "Custom", disabled: false, pressed: "false" },
    ]);
    expect(buttons(html).map((b) => b.text)).toContain("Book this slot");
    expect(html).not.toContain("Group session");
  });

  it("only 30 minutes free: still books 30 min, no refusal", () => {
    const html = oneTap(CAGE, 30);
    expect(alerts(html)).toEqual([]);
    expect(durationButtons(html)).toEqual([
      { text: "30 min", disabled: false, pressed: "true" },
    ]);
    expect(paragraphs(html)).toContain("Next slot is busy — 30 min only.");
    expect(buttons(html).map((b) => b.text)).toContain("Book this slot");
  });
});

describe("batch panel, weight room", () => {
  it("a lone pick: refusal shown and Book disabled", () => {
    const html = batch([key(WR, S3PM)]);
    expect(alerts(html)).toEqual([
      [
        "Weight room rentals are one hour minimum.",
        "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. Add 2:30 PM or 3:30 PM too, or remove it.",
      ],
    ]);
    const book = buttons(html).find((b) => b.text.startsWith("Book "));
    expect(book).toEqual({ text: "Book 1 rental", disabled: true, pressed: null });
    expect(header(html)).toBe("Book 1 rental");
    expect(paragraphs(html)).toContain("3:00 PM – 3:30 PM (30 min, not enough)");
    expect(paragraphs(html)).toContain(
      "Weight room rentals are one hour minimum: pick back-to-back half hours on the same spot.",
    );
  });

  it("a back-to-back pair: one rental listed, Book 1 rental", () => {
    const html = batch([key(WR, S3PM), key(WR, S3PM + 1)]);
    expect(alerts(html)).toEqual([]);
    expect(paragraphs(html)).toContain("3:00 PM – 4:00 PM (1 hr)");
    const book = buttons(html).find((b) => b.text.startsWith("Book "));
    expect(book).toEqual({ text: "Book 1 rental", disabled: false, pressed: null });
    // The panel's title counts the rental saved, not the two taps.
    expect(header(html)).toBe("Book 1 rental");
    expect(html).not.toContain("Group session");
  });

  it("a mixed booking with a lone weight room pick is refused whole", () => {
    const html = batch([key(CAGE, 2), key(WR, S3PM)], (resourceId, i) =>
      resourceId === WR.id && (i === S3PM - 1 || i === S3PM + 1)
        ? "taken"
        : "free",
    );
    expect(alerts(html)).toEqual([
      [
        "Weight room rentals are one hour minimum.",
        "Oct 17, 2026, 3:00 PM on Weight Room 1 is a single half hour. The half hours next to it are taken, so remove it.",
      ],
    ]);
    const book = buttons(html).find((b) => b.text.startsWith("Book "));
    expect(book?.disabled).toBe(true);
    expect(header(html)).toBe("Book 2 rentals");
  });

  it("four back-to-back picks on one weight room: one rental of 2 hr in the title and the button", () => {
    const html = batch([0, 1, 2, 3].map((i) => key(WR, S3PM + i)));
    expect(alerts(html)).toEqual([]);
    expect(paragraphs(html)).toContain("3:00 PM – 5:00 PM (2 hr)");
    expect(header(html)).toBe("Book 1 rental");
    const book = buttons(html).find((b) => b.text.startsWith("Book "));
    expect(book).toEqual({ text: "Book 1 rental", disabled: false, pressed: null });
  });
});

describe("batch panel, cage (unchanged review text)", () => {
  it("two cage slots: today's review line, two rentals, no hint, no refusal", () => {
    const html = batch([key(CAGE, S3PM), key(CAGE, S3PM + 1)]);
    expect(alerts(html)).toEqual([]);
    expect(paragraphs(html)).toContain("3:00 PM, 3:30 PM — 2 rentals of 30 min");
    const book = buttons(html).find((b) => b.text.startsWith("Book "));
    expect(book).toEqual({ text: "Book 2 rentals", disabled: false, pressed: null });
    // Cages: one rental per slot, so the number is the slot count as before.
    expect(header(html)).toBe("Book 2 rentals");
    expect(html).not.toContain("Weight room rentals are one hour minimum");
    expect(html).not.toContain("Group session");
  });
});
