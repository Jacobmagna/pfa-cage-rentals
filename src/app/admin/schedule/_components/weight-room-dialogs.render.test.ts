// What the two admin create dialogs render for a weight room, and that a
// cage still renders as it did. Static render of each dialog as it OPENS
// (no clicks, no typing); the server actions are stubbed because nothing is
// sent.
//
//   - ScheduleCreateDialog, Session tab (the day grid, /master/schedule and
//     admin Home): prefilled from a clicked or painted cell.
//   - SessionFormDialog in create mode (Rentals "New rental"), seeded the same
//     way through `initial`; and in edit mode, where an old 30-minute weight
//     room rental must still open editable (no client-side block).
//
// Every text assertion is scoped to the element it is about: an alert box,
// a button, or a paragraph.

import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/admin/sessions/form-actions", () => ({
  createSessionFormAction: vi.fn(),
  createSessionsBatchAction: vi.fn(),
  updateSessionFormAction: vi.fn(),
  deleteSessionAction: vi.fn(),
}));
vi.mock("@/app/admin/schedule/actions", () => ({
  createBlockSeries: vi.fn(),
  createBlocksBatch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { ScheduleCreateDialog } from "./schedule-create-dialog";
import { SessionFormDialog } from "@/app/admin/sessions/_components/session-form-dialog";
import type {
  CoachOption,
  ResourceOption,
} from "@/app/admin/sessions/_components/sessions-client";
import { pfaWallClockToUtc } from "@/lib/timezone";

const WR: ResourceOption = {
  id: "wr-1",
  name: "Weight Room 1",
  type: "weight_room",
  sortOrder: 1,
};
const CAGE: ResourceOption = { id: "cage-1", name: "Cage 1", type: "cage", sortOrder: 0 };
const RESOURCES = [CAGE, WR];
const COACHES: CoachOption[] = [
  { id: "coach-1", name: "Coach One", email: "one@example.com" },
];

const DAY = "2026-10-17";
const at = (time: string) => pfaWallClockToUtc(DAY, time);

const REFUSAL =
  "Weight room rentals are one hour minimum. Make the end time at least 1 hour after the start.";
const LATE_REFUSAL =
  "Weight room rentals are one hour minimum, and the last hour starts at 9:00 PM. Pick an earlier start.";

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

function alerts(html: string): string[] {
  return [...html.matchAll(/<div role="alert"[^>]*>([\s\S]*?)<\/div>/g)].map(
    (m) => textOf(m[1]),
  );
}

type Button = { text: string; disabled: boolean };

/** The form's submit button (each dialog has exactly one). */
function submitButton(html: string): Button {
  const all = [
    ...html.matchAll(/<button([^>]*type="submit"[^>]*)>([\s\S]*?)<\/button>/g),
  ];
  expect(all).toHaveLength(1);
  return {
    text: textOf(all[0][2]),
    disabled: /\sdisabled=""/.test(all[0][1]),
  };
}

function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)].map((m) =>
    textOf(m[1]),
  );
}

function willCreateLines(html: string): string[] {
  return paragraphs(html).filter((p) => p.startsWith("Will create"));
}

function noteInputs(html: string): number {
  return [...html.matchAll(/<input[^>]*name="note"[^>]*>/g)].length;
}

function renderCreateDialog(resourceId: string, start: string, end: string) {
  return renderToStaticMarkup(
    createElement(ScheduleCreateDialog, {
      open: true,
      onClose: () => {},
      coaches: COACHES,
      resources: RESOURCES,
      programs: [],
      prefill: { resourceId, startAt: at(start), endAt: at(end) },
      defaultTab: "session",
    }),
  );
}

function renderSessionDialog(
  mode: "create" | "edit",
  resourceId: string,
  start: string,
  end: string,
  isGroupSession = false,
) {
  return renderToStaticMarkup(
    createElement(SessionFormDialog, {
      open: true,
      mode,
      onClose: () => {},
      coachOptions: COACHES,
      resourceOptions: RESOURCES,
      initial: {
        id: "rental-1",
        coachId: "coach-1",
        resourceId,
        startAt: at(start),
        endAt: at(end),
        note: null,
        isGroupSession,
      },
    }),
  );
}

// The two create dialogs must behave identically on a weight room, so the
// same cases run against both.
const CREATE_DIALOGS = [
  {
    label: "ScheduleCreateDialog, Session tab",
    render: (resourceId: string, start: string, end: string) =>
      renderCreateDialog(resourceId, start, end),
  },
  {
    label: "SessionFormDialog, create mode",
    render: (resourceId: string, start: string, end: string) =>
      renderSessionDialog("create", resourceId, start, end),
  },
];

for (const dialog of CREATE_DIALOGS) {
  describe(`${dialog.label}: weight room`, () => {
    it("30 minutes: refused inline, submit disabled, no slot length, no group checkbox, no summary line", () => {
      const html = dialog.render(WR.id, "15:00", "15:30");
      expect(alerts(html)).toEqual([REFUSAL]);
      expect(submitButton(html)).toEqual({
        text: "Create session",
        disabled: true,
      });
      expect(html).not.toContain("Slot length");
      expect(html).not.toContain("Group session");
      expect(html).not.toContain('name="isGroupSession"');
      expect(willCreateLines(html)).toEqual([]);
      expect(noteInputs(html)).toBe(1);
    });

    it("9:30 PM, 30 minutes: the refusal names the last hour's start, submit disabled", () => {
      const html = dialog.render(WR.id, "21:30", "22:00");
      expect(alerts(html)).toEqual([LATE_REFUSAL]);
      expect(submitButton(html)).toEqual({
        text: "Create session",
        disabled: true,
      });
    });

    it("9:00 PM, 30 minutes: an hour still fits, so the usual refusal", () => {
      const html = dialog.render(WR.id, "21:00", "21:30");
      expect(alerts(html)).toEqual([REFUSAL]);
    });

    it("1 hour: one session line, submit enabled, one Note field", () => {
      const html = dialog.render(WR.id, "15:00", "16:00");
      expect(alerts(html)).toEqual([]);
      expect(willCreateLines(html)).toEqual(["Will create 1 session of 1 hr."]);
      expect(submitButton(html)).toEqual({
        text: "Create session",
        disabled: false,
      });
      expect(html).not.toContain("Slot length");
      expect(html).not.toContain("Group session");
      expect(html).not.toContain('name="isGroupSession"');
      expect(noteInputs(html)).toBe(1);
    });

    it("1 hr 30 min: still ONE session, never split by slot length", () => {
      const html = dialog.render(WR.id, "15:00", "16:30");
      expect(alerts(html)).toEqual([]);
      expect(willCreateLines(html)).toEqual([
        "Will create 1 session of 1 hr 30 min.",
      ]);
      expect(submitButton(html)).toEqual({
        text: "Create session",
        disabled: false,
      });
      expect(noteInputs(html)).toBe(1);
    });
  });

  describe(`${dialog.label}: cage (unchanged)`, () => {
    it("30 minutes: one 30-minute session, slot length shown, enabled", () => {
      const html = dialog.render(CAGE.id, "15:00", "15:30");
      expect(alerts(html)).toEqual([]);
      expect(html).toContain("Slot length");
      expect(willCreateLines(html)).toEqual([
        "Will create 1 session of 30 min each.",
      ]);
      expect(submitButton(html)).toEqual({
        text: "Create session",
        disabled: false,
      });
      expect(noteInputs(html)).toBe(1);
    });

    it("1 hour: split into two 30-minute sessions as before", () => {
      const html = dialog.render(CAGE.id, "15:00", "16:00");
      expect(alerts(html)).toEqual([]);
      expect(html).toContain("Slot length");
      expect(willCreateLines(html)).toEqual([
        "Will create 2 sessions of 30 min each.",
      ]);
      expect(submitButton(html)).toEqual({
        text: "Create 2 sessions",
        disabled: false,
      });
      // Per-slot notes replace the single Note field.
      expect(noteInputs(html)).toBe(0);
    });
  });
}

describe("ScheduleCreateDialog: no group checkbox on a cage either", () => {
  it("never renders the Group session checkbox or its hidden field", () => {
    const html = renderCreateDialog(CAGE.id, "15:00", "15:30");
    expect(html).not.toContain("Group session");
    expect(html).not.toContain('name="isGroupSession"');
  });
});

describe("SessionFormDialog, edit mode: no client-side weight room block", () => {
  it("an old 30-minute weight room rental opens editable: no alert, Save enabled, no summary line", () => {
    const html = renderSessionDialog("edit", WR.id, "15:00", "15:30");
    expect(alerts(html)).toEqual([]);
    expect(submitButton(html)).toEqual({
      text: "Save changes",
      disabled: false,
    });
    expect(willCreateLines(html)).toEqual([]);
    expect(html).not.toContain("Slot length");
    expect(noteInputs(html)).toBe(1);
  });

  it("keeps the Group pill on an old group rental", () => {
    const withGroup = renderSessionDialog("edit", WR.id, "15:00", "16:00", true);
    const withoutGroup = renderSessionDialog("edit", WR.id, "15:00", "16:00");
    expect(withGroup).toContain("Group");
    expect(withoutGroup).not.toContain("Group");
  });
});
