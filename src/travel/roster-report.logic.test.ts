import { describe, expect, it } from "vitest";
import {
  foldDues,
  formatPlayerName,
  matchesPlayerSearch,
  type SearchableRow,
} from "./roster-report.logic";

// Pure-module unit tests for the master-player-list helpers (no DB I/O). The
// impure roster-report.ts batches the reads and hands per-athlete slices to
// these; here we exercise the dues fold and the search predicate directly.

describe("foldDues", () => {
  it("no invoices → all zero / empty statuses", () => {
    expect(foldDues([])).toEqual({
      billedCents: 0,
      collectedCents: 0,
      outstandingCents: 0,
      invoiceStatuses: [],
    });
  });

  it("sums billed/collected/outstanding across mixed statuses", () => {
    const dues = foldDues([
      // fully paid: bills 10000, collected 10000, not outstanding
      { totalCents: 10000, balanceCents: 0, status: "paid" },
      // partial: bills 20000, collected 5000, outstanding 15000
      { totalCents: 20000, balanceCents: 15000, status: "partial" },
      // pending: bills 5000, collected 0, outstanding 5000
      { totalCents: 5000, balanceCents: 5000, status: "pending" },
    ]);
    expect(dues.billedCents).toBe(35000);
    expect(dues.collectedCents).toBe(15000);
    expect(dues.outstandingCents).toBe(20000);
    expect(dues.invoiceStatuses).toEqual(["paid", "partial", "pending"]);
  });

  it("excludes VOID invoices from billed AND collected AND outstanding", () => {
    const dues = foldDues([
      { totalCents: 9999, balanceCents: 9999, status: "void" },
      { totalCents: 1000, balanceCents: 0, status: "paid" },
    ]);
    expect(dues.billedCents).toBe(1000); // void's 9999 not billed
    expect(dues.collectedCents).toBe(1000);
    expect(dues.outstandingCents).toBe(0); // void is settled, not owed
    expect(dues.invoiceStatuses).toEqual(["paid", "void"]);
  });

  it("refunded invoice bills + collects but is NOT outstanding", () => {
    const dues = foldDues([
      { totalCents: 8000, balanceCents: 0, status: "refunded" },
    ]);
    expect(dues.billedCents).toBe(8000);
    expect(dues.collectedCents).toBe(8000);
    expect(dues.outstandingCents).toBe(0);
    expect(dues.invoiceStatuses).toEqual(["refunded"]);
  });

  it("dedupes + sorts statuses", () => {
    const dues = foldDues([
      { totalCents: 100, balanceCents: 100, status: "pending" },
      { totalCents: 100, balanceCents: 50, status: "partial" },
      { totalCents: 100, balanceCents: 100, status: "pending" },
    ]);
    expect(dues.invoiceStatuses).toEqual(["partial", "pending"]);
  });
});

describe("formatPlayerName", () => {
  it("joins first + last", () => {
    expect(formatPlayerName("Ava", "Diaz")).toBe("Ava Diaz");
  });

  it("drops a missing half without stray spaces", () => {
    expect(formatPlayerName("Ava", null)).toBe("Ava");
    expect(formatPlayerName(null, "Diaz")).toBe("Diaz");
    expect(formatPlayerName(null, null)).toBe("");
  });
});

describe("matchesPlayerSearch", () => {
  const row: SearchableRow = {
    athleteName: "Ava Diaz",
    teams: [{ teamName: "PFA 14U Black" }],
    guardians: [
      { guardianName: "Maria Diaz", email: "maria@example.com" },
      { guardianName: "Jose Diaz", email: "jose@example.org" },
    ],
  };

  it("empty / whitespace query matches everything", () => {
    expect(matchesPlayerSearch(row, "")).toBe(true);
    expect(matchesPlayerSearch(row, "   ")).toBe(true);
  });

  it("matches athlete name case-insensitively", () => {
    expect(matchesPlayerSearch(row, "ava")).toBe(true);
    expect(matchesPlayerSearch(row, "DIAZ")).toBe(true);
  });

  it("matches a team name", () => {
    expect(matchesPlayerSearch(row, "14u")).toBe(true);
  });

  it("matches a guardian name", () => {
    expect(matchesPlayerSearch(row, "jose")).toBe(true);
  });

  it("matches a guardian email", () => {
    expect(matchesPlayerSearch(row, "maria@example")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesPlayerSearch(row, "zzz-nomatch")).toBe(false);
  });
});
