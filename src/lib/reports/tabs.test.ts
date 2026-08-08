// Reports sub-tab resolution. The important property is that NOTHING
// can produce an unrenderable tab: every malformed input falls back to
// the cage view rather than yielding an empty page.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPORT_TAB,
  REPORT_TABS,
  normalizeReportTab,
  reportTabLabel,
  type ReportTab,
} from "./tabs";

describe("normalizeReportTab — known tabs", () => {
  it.each(REPORT_TABS)("resolves %s to itself", (tab) => {
    expect(normalizeReportTab(tab)).toBe(tab);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeReportTab("  work  ")).toBe("work");
  });
});

describe("normalizeReportTab — fallback to the default", () => {
  it("defaults when absent", () => {
    expect(normalizeReportTab(undefined)).toBe(DEFAULT_REPORT_TAB);
  });

  it("defaults on an empty string", () => {
    expect(normalizeReportTab("")).toBe(DEFAULT_REPORT_TAB);
  });

  it("defaults on whitespace only", () => {
    expect(normalizeReportTab("   ")).toBe(DEFAULT_REPORT_TAB);
  });

  it("defaults on an unknown value", () => {
    expect(normalizeReportTab("invoices")).toBe(DEFAULT_REPORT_TAB);
  });

  it("is case-sensitive — 'Work' is not a tab", () => {
    expect(normalizeReportTab("Work")).toBe(DEFAULT_REPORT_TAB);
  });

  it("defaults on an empty array", () => {
    expect(normalizeReportTab([])).toBe(DEFAULT_REPORT_TAB);
  });

  it("the default is the cage view", () => {
    expect(DEFAULT_REPORT_TAB).toBe("cage");
  });
});

describe("normalizeReportTab — repeated params", () => {
  it("takes the first value when the key repeats", () => {
    expect(normalizeReportTab(["payments", "work"])).toBe("payments");
  });

  it("does NOT fall through to a later valid value", () => {
    // ?tab=bogus&tab=work resolves to the default, not "work" — first
    // wins, matching how the other filters read repeated scalar keys.
    expect(normalizeReportTab(["bogus", "work"])).toBe(DEFAULT_REPORT_TAB);
  });
});

describe("reportTabLabel", () => {
  it.each<[ReportTab, string]>([
    ["cage", "Cage rentals"],
    ["work", "Work hours"],
    ["payments", "Payments"],
  ])("labels %s as %s", (tab, label) => {
    expect(reportTabLabel(tab)).toBe(label);
  });

  it("every tab has a non-empty label", () => {
    for (const tab of REPORT_TABS) {
      expect(reportTabLabel(tab)).not.toBe("");
    }
  });
});

describe("REPORT_TABS", () => {
  it("is exactly the three tabs the spec names, in display order", () => {
    expect([...REPORT_TABS]).toEqual(["cage", "work", "payments"]);
  });
});
