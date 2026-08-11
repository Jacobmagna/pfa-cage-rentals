// payment-statement SPEC §6 — the period chips, which the design mock declared
// as an optional prop and NEVER PASSED. So this render path shipped unexercised;
// Phase C wires it, and this pins what "wired" means:
//
//   · every preset becomes a link, in order, carrying the href it was given
//   · exactly one chip is marked current, and only when the range matches
//   · omitting the prop still renders the card (the control is optional, and a
//     card that crashed without it would take the whole tab down)
//
// The presets themselves — which three months, and that each resolves through
// `normalizeFilters` to its `pfaMonthRange` — are covered in
// `src/lib/statement/period.test.ts`. This file is only about what reaches HTML.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StatementCard } from "./statement-card";
import { statementPeriodPresets } from "@/lib/statement/period";
import { normalizeFilters } from "@/lib/reports/filters";
import { statementHref } from "@/lib/statement/links";
import type { Statement, StatementPair } from "@/lib/statement/types";

function blank(account: "cage" | "work"): Statement {
  return {
    account,
    directionLabel: account === "cage" ? "Alex Milone owes PFA" : "PFA owes Alex Milone",
    openingLabel: "Previous balance (as of Jun 30)",
    closingLabel: "Statement balance as of Jul 31",
    openingCents: 0,
    chargesCents: 0,
    paymentsCents: 0,
    closingCents: 0,
    chargeLines: [],
    chargeRows: [],
    paymentRows: [],
    unappliedCents: 0,
    chargesAfterCents: 0,
    paymentsCoveringAfterCents: 0,
    currentBalanceCents: 0,
    caveat: null,
    scopeNote: null,
  };
}

const PAIR: StatementPair = {
  coachName: "Alex Milone",
  coachEmail: "alexmilone@example.com",
  periodLabel: "Jul 1 – Jul 31, 2026",
  periodEndShort: "Jul 31",
  cage: blank("cage"),
  work: blank("work"),
};

/** Exactly what the page builds: presets → chips, active when both ends match. */
function chipsFor(from: string, to: string) {
  const filters = normalizeFilters({ from, to, coachIds: ["coach-a"] });
  // A fixed clock so the three months are Jun/Jul/Aug regardless of today.
  return statementPeriodPresets(new Date("2026-08-11T19:00:00.000Z")).map(
    (preset) => ({
      label: preset.label,
      href: statementHref(filters, "cage", {
        from: preset.from,
        to: preset.to,
      }),
      active: filters.from === preset.from && filters.to === preset.to,
    }),
  );
}

function render(chips?: ReturnType<typeof chipsFor>): string {
  return renderToStaticMarkup(
    createElement(StatementCard, {
      pair: PAIR,
      account: "cage",
      hrefForAccount: (a) => `/admin/reports?tab=statements&account=${a}`,
      periodChips: chips,
    }),
  );
}

/** Chip anchors only — the account switcher's two links are excluded. */
function chipLinks(html: string): { href: string; current: boolean; text: string }[] {
  const section = html.slice(html.indexOf(">Period<"));
  return [...section.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map((m) => ({
    href: /\bhref="([^"]*)"/.exec(m[1])?.[1] ?? "",
    current: /\baria-current="true"/.test(m[1]),
    text: m[2],
  }));
}

describe("StatementCard — period chips", () => {
  it("renders one link per preset, oldest first", () => {
    const links = chipLinks(render(chipsFor("2026-07-01", "2026-07-31")));
    expect(links.map((l) => l.text)).toEqual(["Jun", "Jul", "Aug"]);
  });

  it("marks exactly the chip matching the current range", () => {
    const links = chipLinks(render(chipsFor("2026-07-01", "2026-07-31")));
    expect(links.filter((l) => l.current).map((l) => l.text)).toEqual(["Jul"]);
  });

  it("marks nothing when the range is not a whole month", () => {
    // A hand-typed part-month must not light up a chip claiming to be the
    // month — the chip would then name a period the arithmetic does not cover.
    const links = chipLinks(render(chipsFor("2026-07-05", "2026-07-20")));
    expect(links.filter((l) => l.current)).toHaveLength(0);
  });

  it("each chip href carries the coach scope and its own month", () => {
    const links = chipLinks(render(chipsFor("2026-07-01", "2026-07-31")));
    const june = new URLSearchParams(
      links[0].href.replace(/&amp;/g, "&").slice(links[0].href.indexOf("?") + 1),
    );
    expect(june.get("from")).toBe("2026-06-01");
    expect(june.get("to")).toBe("2026-06-30");
    expect(june.getAll("coachIds")).toEqual(["coach-a"]);
    expect(june.get("tab")).toBe("statements");
  });

  it("renders without the prop at all", () => {
    const html = render(undefined);
    expect(html).not.toContain(">Period<");
    expect(html).toContain("Alex Milone");
  });

  it("renders nothing for an empty chip list", () => {
    expect(render([])).not.toContain(">Period<");
  });
});
