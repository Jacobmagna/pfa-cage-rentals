// 🔴 REGRESSION SUITE FOR THE P0 in the program edit dialog:
// "the dialog can preview one rate and save a different one".
//
// The two amount inputs used to be UNCONTROLLED and CONDITIONALLY RENDERED —
// `defaultValue` + `onChange` inside the two arms of a
// `{perSession ? … : …}` ternary — with a `useRef` mirroring what had been
// typed so the inline re-price preview could price it. Toggling the pay mode
// swapped the arms, React unmounted the input and mounted a fresh one seeded
// from `defaults`, and the ref kept the typed value. From that instant the DOM
// (what FormData submits, and therefore what the engine writes) and the ref
// (what the confirm screen priced) disagreed.
//
// The worst shape of it: toggle the mode on a per-session program and the
// submitted hourly field was EMPTY, so both rate columns went null and every
// in-window log re-priced to $0 — with the decrease confirmation already
// ticked, because the admin ticked it for a different number.
//
// These tests run the exact sequence that produced it — type → toggle →
// toggle back — and assert the two readings agree, both as raw strings and as
// the integer CENTS each side would hand to the engine. The unit suite has no
// DOM (vitest.config.ts pins `environment: "node"`), which is why the state
// and its transitions live in a plain module: the component now renders
// `values.rateDollars` / `values.perSessionDollars` as CONTROLLED inputs, so
// "what the DOM holds" and "what this object holds" are the same fact.

import { describe, expect, it } from "vitest";
import {
  initialProgramPayFields,
  programPayCandidateKey,
  programPayFieldEntries,
  setProgramPayAmount,
  setProgramPayMode,
  toProgramPayFormData,
  type ProgramPayFieldValues,
} from "./program-pay-fields";
import {
  optionalHourlyDollarsToCentsPer30Min,
  optionalSessionDollarsToCents,
  tryFlatDollarsToCents,
  tryOptionalHourlyDollarsToCentsPer30Min,
} from "./rate-input";

/** A program that pays $100 flat per session — the shape of the worst case. */
const PER_SESSION_PROGRAM: ProgramPayFieldValues = {
  payMode: "per_session",
  rateDollars: "",
  perSessionDollars: "100.00",
};

/** A program that pays $44/hr. */
const HOURLY_PROGRAM: ProgramPayFieldValues = {
  payMode: "hourly",
  rateDollars: "44.00",
  perSessionDollars: "",
};

/**
 * What the SERVER would write, derived from the posted FormData exactly the
 * way `buildProgramInput` (form-actions.ts) does it — including the rule that
 * the mode decides which column survives.
 */
function serverWrites(fd: FormData): {
  payMode: "hourly" | "per_session";
  defaultRatePer30MinCents: number | null;
  defaultPerSessionRateCents: number | null;
} {
  const payMode =
    fd.get("payMode")?.toString() === "per_session" ? "per_session" : "hourly";
  const hourly = optionalHourlyDollarsToCentsPer30Min(
    fd.get("rateDollars")?.toString() ?? "",
  );
  const flat = optionalSessionDollarsToCents(
    fd.get("perSessionDollars")?.toString() ?? "",
  );
  return {
    payMode,
    defaultRatePer30MinCents: payMode === "per_session" ? null : hourly,
    defaultPerSessionRateCents: payMode === "per_session" ? flat : null,
  };
}

/**
 * What the PREVIEW would price, derived from the live values exactly the way
 * `runPreview` (program-form-dialog.tsx) builds its `candidateRate`.
 */
function previewPrices(values: ProgramPayFieldValues): {
  payMode: "hourly" | "per_session";
  defaultRatePer30MinCents: number | null;
  defaultPerSessionRateCents: number | null;
} {
  const perSession = values.payMode === "per_session";
  return {
    payMode: values.payMode,
    defaultRatePer30MinCents: perSession
      ? null
      : tryOptionalHourlyDollarsToCentsPer30Min(values.rateDollars),
    defaultPerSessionRateCents: perSession
      ? tryFlatDollarsToCents(values.perSessionDollars)
      : null,
  };
}

describe("the pay-mode toggle never touches an amount", () => {
  it("keeps a freshly typed hourly rate across per-session → hourly → per-session", () => {
    let v = initialProgramPayFields(PER_SESSION_PROGRAM);
    // Mark decides this program should pay by time and types the new rate.
    v = setProgramPayMode(v, "hourly");
    v = setProgramPayAmount(v, "rateDollars", "52.00");
    // …then flips back and forth while thinking about it. THIS is the
    // sequence that used to wipe the field.
    v = setProgramPayMode(v, "per_session");
    v = setProgramPayMode(v, "hourly");

    expect(v.rateDollars).toBe("52.00");
    expect(v.perSessionDollars).toBe("100.00");
    expect(v.payMode).toBe("hourly");
  });

  it("keeps a freshly typed per-session amount across the mirrored sequence", () => {
    let v = initialProgramPayFields(HOURLY_PROGRAM);
    v = setProgramPayMode(v, "per_session");
    v = setProgramPayAmount(v, "perSessionDollars", "150.00");
    v = setProgramPayMode(v, "hourly");
    v = setProgramPayMode(v, "per_session");

    expect(v.perSessionDollars).toBe("150.00");
    expect(v.rateDollars).toBe("44.00");
  });

  it("never copies one amount into the other", () => {
    let v = initialProgramPayFields(HOURLY_PROGRAM);
    v = setProgramPayMode(v, "per_session");
    expect(v.perSessionDollars).toBe("");
    expect(v.rateDollars).toBe("44.00");
  });

  it("does not mutate the object it was handed", () => {
    const before = initialProgramPayFields(HOURLY_PROGRAM);
    setProgramPayMode(before, "per_session");
    setProgramPayAmount(before, "rateDollars", "999.00");
    expect(before).toEqual(HOURLY_PROGRAM);
  });
});

describe("the submitted payload and the previewed candidate are one value", () => {
  it("agree after type → toggle → toggle back (hourly)", () => {
    let v = initialProgramPayFields(PER_SESSION_PROGRAM);
    v = setProgramPayMode(v, "hourly");
    v = setProgramPayAmount(v, "rateDollars", "52.00");
    v = setProgramPayMode(v, "per_session");
    v = setProgramPayMode(v, "hourly");

    const fd = toProgramPayFormData(v);
    // The raw strings the browser would post.
    expect(fd.get("payMode")).toBe("hourly");
    expect(fd.get("rateDollars")).toBe("52.00");
    // Both fields are ALWAYS posted — that is what lets the server clear the
    // column the chosen mode no longer uses.
    expect(fd.get("perSessionDollars")).toBe("100.00");

    // …and the two sides land on the SAME cents. $52/hr → 2600¢ per 30 min.
    expect(serverWrites(fd)).toEqual(previewPrices(v));
    expect(serverWrites(fd)).toEqual({
      payMode: "hourly",
      defaultRatePer30MinCents: 2_600,
      defaultPerSessionRateCents: null,
    });
  });

  it("agree after type → toggle → toggle back (per session)", () => {
    let v = initialProgramPayFields(HOURLY_PROGRAM);
    v = setProgramPayMode(v, "per_session");
    v = setProgramPayAmount(v, "perSessionDollars", "150.00");
    v = setProgramPayMode(v, "hourly");
    v = setProgramPayMode(v, "per_session");

    const fd = toProgramPayFormData(v);
    expect(serverWrites(fd)).toEqual(previewPrices(v));
    // FLAT, never halved (bug class 0052).
    expect(serverWrites(fd)).toEqual({
      payMode: "per_session",
      defaultRatePer30MinCents: null,
      defaultPerSessionRateCents: 15_000,
    });
  });

  it("🔴 a bare mode toggle on a per-session program cannot null both rate columns", () => {
    // The exact P0 outcome: with the old uncontrolled inputs, switching a
    // per-session program to hourly submitted an EMPTY rateDollars (the
    // remounted input re-seeded from `defaults`, where the hourly amount is
    // "" because the program pays per session) — both columns null, every
    // in-window log re-priced to $0.
    let v = initialProgramPayFields(PER_SESSION_PROGRAM);
    v = setProgramPayAmount(v, "rateDollars", "30.00");
    v = setProgramPayMode(v, "hourly");

    const written = serverWrites(toProgramPayFormData(v));
    expect(written).toEqual(previewPrices(v));
    expect(written.defaultRatePer30MinCents).toBe(1_500);
    // And the honest empty case still reads as "no rate", not as a typo.
    const empty = initialProgramPayFields(PER_SESSION_PROGRAM);
    const emptied = serverWrites(
      toProgramPayFormData(setProgramPayMode(empty, "hourly")),
    );
    expect(emptied.defaultRatePer30MinCents).toBeNull();
    expect(emptied).toEqual(previewPrices(setProgramPayMode(empty, "hourly")));
  });

  it("posts exactly three fields, in both modes", () => {
    for (const v of [HOURLY_PROGRAM, PER_SESSION_PROGRAM]) {
      expect(programPayFieldEntries(v).map(([name]) => name)).toEqual([
        "payMode",
        "rateDollars",
        "perSessionDollars",
      ]);
    }
  });
});

describe("the preview refetch key", () => {
  it("changes when any of the three values changes, and only then", () => {
    const v = initialProgramPayFields(HOURLY_PROGRAM);
    const base = programPayCandidateKey(v);
    expect(programPayCandidateKey(setProgramPayMode(v, "hourly"))).toBe(base);
    expect(
      programPayCandidateKey(setProgramPayMode(v, "per_session")),
    ).not.toBe(base);
    expect(
      programPayCandidateKey(setProgramPayAmount(v, "rateDollars", "45.00")),
    ).not.toBe(base);
    expect(
      programPayCandidateKey(
        setProgramPayAmount(v, "perSessionDollars", "10.00"),
      ),
    ).not.toBe(base);
  });
});
