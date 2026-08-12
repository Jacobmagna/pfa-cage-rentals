// `DateInput`'s OPT-IN raw-text hidden input.
//
// The ISO hidden input is "" for anything that is not a fully valid calendar
// date, so a server reading only the ISO cannot tell an EMPTY box from a
// MISTYPED one. On payments' `covers_through`, where blank is legal and means
// "no period stated", that ambiguity silently cleared a coverage date the user
// had already set. `rawName` closes it.
//
// ⚠️ `DateInput` is used by ~20 surfaces across this app, so the contract test
// that matters most is the LAST one here: without `rawName`, the emitted fields
// are byte-identical to what they always were.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DateInput } from "./date-input";

/** Every hidden input the component emits, as {name, value}. */
function hiddens(html: string): { name: string; value: string }[] {
  return [...html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)].map((m) => ({
    name: /\bname="([^"]*)"/.exec(m[0])?.[1] ?? "",
    value: /\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? "",
  }));
}

function markup(props: Parameters<typeof DateInput>[0]): string {
  return renderToStaticMarkup(createElement(DateInput, props));
}

describe("DateInput rawName", () => {
  it("emits the raw MASKED text beside the ISO", () => {
    expect(
      hiddens(
        markup({ name: "coversThroughDate", rawName: "coversThroughRaw", value: "2026-07-31" }),
      ),
    ).toEqual([
      { name: "coversThroughDate", value: "2026-07-31" },
      { name: "coversThroughRaw", value: "07/31/2026" },
    ]);
  });

  it("is EMPTY when the field is empty — so a real blank stays a real blank", () => {
    expect(hiddens(markup({ name: "d", rawName: "dRaw", value: "" }))).toEqual([
      { name: "d", value: "" },
      { name: "dRaw", value: "" },
    ]);
  });

  it("works on an UNCONTROLLED field too", () => {
    expect(
      hiddens(markup({ name: "d", rawName: "dRaw", defaultValue: "2024-02-29" })),
    ).toEqual([
      { name: "d", value: "2024-02-29" },
      { name: "dRaw", value: "02/29/2024" },
    ]);
  });

  it("🔴 emits NOTHING extra when `rawName` is omitted", () => {
    // The contract every other caller in the app depends on. `rawName` is opt-in
    // precisely so this feature could not change their server contract.
    expect(hiddens(markup({ name: "from", defaultValue: "2026-07-01" }))).toEqual([
      { name: "from", value: "2026-07-01" },
    ]);
    expect(hiddens(markup({ name: "from", value: "" }))).toEqual([
      { name: "from", value: "" },
    ]);
  });

  it("emits no hidden input at all with neither name", () => {
    expect(hiddens(markup({ value: "2026-07-01" }))).toEqual([]);
  });
});
