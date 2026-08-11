// payment-statement SPEC §5.0 — the account switcher's query param.
//
// Two properties, and the second is the load-bearing one:
//
//   1. Nothing can produce an unrenderable account. Every malformed input
//      falls back to the cage view rather than yielding a blank document —
//      the same contract, and the same fallback SHAPE, `normalizeReportTab`
//      already guarantees for `tab`.
//   2. 🔴 THE ACCOUNT NEVER REACHES `NormalizedFilters`. It selects which of
//      two already-computed statements is displayed; if it could reach the
//      filter object it could narrow a fetch, a workbook sheet or the download.
//      Asserted against the real parser and the real serializer, not by reading
//      the type — a type says what today's code does, a test says what a future
//      edit is not allowed to do.

import { describe, expect, it } from "vitest";
import {
  filtersFromURLSearchParams,
  filtersToQueryString,
  normalizeFilters,
} from "@/lib/reports/filters";
import {
  DEFAULT_STATEMENT_ACCOUNT,
  STATEMENT_ACCOUNTS,
  normalizeStatementAccount,
  statementAccountLabel,
} from "./types";

describe("normalizeStatementAccount — known accounts", () => {
  it.each(STATEMENT_ACCOUNTS)("resolves %s to itself", (account) => {
    expect(normalizeStatementAccount(account)).toBe(account);
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeStatementAccount("  work  ")).toBe("work");
  });
});

describe("normalizeStatementAccount — fallback to the default", () => {
  it("defaults when absent", () => {
    expect(normalizeStatementAccount(undefined)).toBe(
      DEFAULT_STATEMENT_ACCOUNT,
    );
  });

  it("defaults on an empty string", () => {
    expect(normalizeStatementAccount("")).toBe(DEFAULT_STATEMENT_ACCOUNT);
  });

  it("defaults on whitespace only", () => {
    expect(normalizeStatementAccount("   ")).toBe(DEFAULT_STATEMENT_ACCOUNT);
  });

  it("defaults on an unknown value", () => {
    expect(normalizeStatementAccount("payroll")).toBe(
      DEFAULT_STATEMENT_ACCOUNT,
    );
  });

  it("is case-sensitive — 'Work' is not an account", () => {
    expect(normalizeStatementAccount("Work")).toBe(DEFAULT_STATEMENT_ACCOUNT);
  });

  it("defaults on an empty array", () => {
    expect(normalizeStatementAccount([])).toBe(DEFAULT_STATEMENT_ACCOUNT);
  });

  it("takes the first value when the key repeats", () => {
    expect(normalizeStatementAccount(["work", "cage"])).toBe("work");
  });

  it("does NOT fall through to a later valid value", () => {
    expect(normalizeStatementAccount(["bogus", "work"])).toBe(
      DEFAULT_STATEMENT_ACCOUNT,
    );
  });

  it("the default is the cage account — the side whose data is complete", () => {
    expect(DEFAULT_STATEMENT_ACCOUNT).toBe("cage");
  });

  it("every account has a label", () => {
    for (const account of STATEMENT_ACCOUNTS) {
      expect(statementAccountLabel(account)).not.toBe("");
    }
  });
});

describe("🔴 the account is NOT a filter", () => {
  it("normalizeFilters ignores it entirely", () => {
    const withAccount = normalizeFilters({
      from: "2026-07-01",
      to: "2026-07-31",
      // @ts-expect-error — `account` is not part of RawFilterInput, and this
      // line failing to compile would be the strongest possible version of
      // this assertion. It is passed anyway to prove the runtime drops it.
      account: "work",
    });
    const without = normalizeFilters({ from: "2026-07-01", to: "2026-07-31" });
    expect(withAccount).toEqual(without);
    expect(Object.keys(withAccount)).not.toContain("account");
  });

  it("filtersToQueryString emits no account (and still no tab)", () => {
    const qs = filtersToQueryString(
      normalizeFilters({
        from: "2026-07-01",
        to: "2026-07-31",
        coachIds: ["c1"],
        resourceTypes: ["cage"],
        programId: "p1",
      }),
    );
    expect(qs).not.toContain("account");
    expect(qs).not.toContain("tab");
  });

  it("the DOWNLOAD route's parser drops both account and tab", () => {
    // The workbook always spans every category. A statement account leaking
    // into it would narrow a money export to one direction while the filename
    // still claimed the full range.
    const withBoth = filtersFromURLSearchParams(
      new URLSearchParams(
        "from=2026-07-01&to=2026-07-31&coachIds=c1&tab=statements&account=work",
      ),
    );
    const without = filtersFromURLSearchParams(
      new URLSearchParams("from=2026-07-01&to=2026-07-31&coachIds=c1"),
    );
    expect(withBoth).toEqual(without);
  });
});
