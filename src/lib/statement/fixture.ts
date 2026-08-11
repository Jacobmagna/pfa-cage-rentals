// ⚠️ DEV-ONLY FIXTURE — DELETE BEFORE THE REAL BUILD LANDS.
//
// Filler data for the /admin/coaches/statement-preview visual mock, so the
// layout can be reviewed before any backend work exists. Nothing here reads
// the database and nothing here is imported by a real page.
//
// The scenario is the REAL one from the SPEC: Alex Milone owed $660 for July
// and Zelled it on Aug 7, and Mark typed "July 2026" into the reference field
// because there was nowhere else to put it.
//
// 🔴 EVERY NUMBER TIES OUT, on purpose. The whole design claim is "arithmetic
// you can add up yourself", so a mock whose columns don't foot would be
// reviewing the opposite of the proposal. Checked here in comments; asserted
// for real in the Phase B tests (SPEC §5.2, §7):
//
//   CAGE   opening 88.00 + charges 660.00 − payments 660.00 = closing  88.00
//          closing 88.00 + after 132.00 − unapplied 170.00  = current  50.00
//   WORK   opening  0.00 + charges 1,200.00 − payments 0.00 = closing 1,200.00
//          closing 1,200.00 + after 360.00 − unapplied 0.00 = current 1,560.00
//
// Rates are PFA's real card: cage/bullpen $44/hr ($22 per 30-min slot),
// weight room $14/hr ($7), group weight room $20/hr ($10), and Alex's work
// rate $30/hr — so the per-row money is checkable by hand too.

import type { Statement, StatementPair } from "./types";

const CAGE: Statement = {
  account: "cage",
  directionLabel: "Alex Milone owes PFA",
  openingLabel: "Previous balance (as of Jun 30)",
  closingLabel: "Statement balance as of Jul 31",

  openingCents: 8_800,
  chargesCents: 66_000,
  paymentsCents: 66_000,
  closingCents: 8_800,

  chargeLines: [
    { label: "Cage", units: "16 slots · 8.0 h", amountCents: 35_200 },
    { label: "Bullpen", units: "8 slots · 4.0 h", amountCents: 17_600 },
    { label: "Weight room", units: "16 slots · 8.0 h", amountCents: 11_200 },
    {
      label: "Group weight room",
      units: "2 slots · 1.0 h",
      amountCents: 2_000,
    },
  ],

  chargeRows: [
    { date: "Jul 02", dayOfWeek: "Thu", timeRange: "9:00 – 11:00 AM", description: "Cage 2", rateLabel: "$44.00/hr", amountCents: 8_800 },
    { date: "Jul 06", dayOfWeek: "Mon", timeRange: "7:00 – 9:00 AM", description: "Weight Room", rateLabel: "$14.00/hr", amountCents: 2_800 },
    { date: "Jul 07", dayOfWeek: "Tue", timeRange: "3:00 – 5:00 PM", description: "Cage 1", rateLabel: "$44.00/hr", amountCents: 8_800 },
    { date: "Jul 09", dayOfWeek: "Thu", timeRange: "4:00 – 6:00 PM", description: "Bullpen 1", rateLabel: "$44.00/hr", amountCents: 8_800 },
    { date: "Jul 13", dayOfWeek: "Mon", timeRange: "7:00 – 9:00 AM", description: "Weight Room", rateLabel: "$14.00/hr", amountCents: 2_800 },
    { date: "Jul 14", dayOfWeek: "Tue", timeRange: "3:00 – 5:00 PM", description: "Cage 1", rateLabel: "$44.00/hr", amountCents: 8_800 },
    { date: "Jul 18", dayOfWeek: "Sat", timeRange: "10:00 – 11:00 AM", description: "Weight Room (Group)", rateLabel: "$20.00/hr", amountCents: 2_000 },
    { date: "Jul 20", dayOfWeek: "Mon", timeRange: "7:00 – 9:00 AM", description: "Weight Room", rateLabel: "$14.00/hr", amountCents: 2_800 },
    { date: "Jul 21", dayOfWeek: "Tue", timeRange: "3:00 – 5:00 PM", description: "Cage 3", rateLabel: "$44.00/hr", amountCents: 8_800 },
    { date: "Jul 23", dayOfWeek: "Thu", timeRange: "4:00 – 6:00 PM", description: "Bullpen 1", rateLabel: "$44.00/hr", amountCents: 8_800 },
    { date: "Jul 27", dayOfWeek: "Mon", timeRange: "7:00 – 9:00 AM", description: "Weight Room", rateLabel: "$14.00/hr", amountCents: 2_800 },
  ],

  paymentRows: [
    {
      paidOn: "Aug 07",
      method: "Zelle",
      reference: "July 2026",
      coversThrough: "Jul 31",
      amountCents: 66_000,
      pending: false,
    },
    {
      paidOn: "Aug 09",
      method: "Check",
      reference: "#1042",
      coversThrough: "Jul 31",
      amountCents: 12_000,
      pending: true,
    },
  ],

  unappliedCents: 17_000,
  chargesAfterCents: 13_200,
  paymentsCoveringAfterCents: 0,
  currentBalanceCents: 5_000,

  caveat: null,
  scopeNote: null,
};

const WORK: Statement = {
  account: "work",
  directionLabel: "PFA owes Alex Milone",
  openingLabel: "Previous balance (as of Jun 30)",
  closingLabel: "Statement balance as of Jul 31",

  openingCents: 0,
  chargesCents: 120_000,
  paymentsCents: 0,
  closingCents: 120_000,

  chargeLines: [
    {
      label: "HS Summer Program-Throwing",
      units: "24.0 h",
      amountCents: 72_000,
    },
    { label: "HS Summer Program", units: "16.0 h", amountCents: 48_000 },
  ],

  chargeRows: [
    { date: "Jul 06", dayOfWeek: "Mon", timeRange: "9:00 AM – 3:00 PM", description: "HS Summer Program-Throwing", rateLabel: "$30.00/hr", amountCents: 18_000 },
    { date: "Jul 07", dayOfWeek: "Tue", timeRange: "9:00 AM – 1:00 PM", description: "HS Summer Program", rateLabel: "$30.00/hr", amountCents: 12_000 },
    { date: "Jul 13", dayOfWeek: "Mon", timeRange: "9:00 AM – 3:00 PM", description: "HS Summer Program-Throwing", rateLabel: "$30.00/hr", amountCents: 18_000 },
    { date: "Jul 14", dayOfWeek: "Tue", timeRange: "9:00 AM – 1:00 PM", description: "HS Summer Program", rateLabel: "$30.00/hr", amountCents: 12_000 },
    { date: "Jul 20", dayOfWeek: "Mon", timeRange: "9:00 AM – 3:00 PM", description: "HS Summer Program-Throwing", rateLabel: "$30.00/hr", amountCents: 18_000 },
    { date: "Jul 21", dayOfWeek: "Tue", timeRange: "9:00 AM – 1:00 PM", description: "HS Summer Program", rateLabel: "$30.00/hr", amountCents: 12_000 },
    { date: "Jul 27", dayOfWeek: "Mon", timeRange: "9:00 AM – 3:00 PM", description: "HS Summer Program-Throwing", rateLabel: "$30.00/hr", amountCents: 18_000 },
    { date: "Jul 28", dayOfWeek: "Tue", timeRange: "9:00 AM – 1:00 PM", description: "HS Summer Program", rateLabel: "$30.00/hr", amountCents: 12_000 },
  ],

  // Empty ON PURPOSE — this is the honest state of the payout ledger today
  // (~2 payment rows facility-wide; Mark pays coaches outside the system).
  // A $1,200 charge total against $0 of recorded payments is meant to look
  // wrong, because it IS wrong, and the caveat below says why (SPEC §11).
  paymentRows: [],

  unappliedCents: 0,
  chargesAfterCents: 36_000,
  paymentsCoveringAfterCents: 0,
  currentBalanceCents: 156_000,

  caveat:
    "This is what the logged work is worth — not what is still owed. PFA pays coaches outside this system, so payments made by cash, Zelle or check that were never recorded here are NOT subtracted below.",
  scopeNote:
    "Posted work only. Rejected and held logs are excluded — they live on the Work Log page.",
};

export const FIXTURE_STATEMENT: StatementPair = {
  coachName: "Alex Milone",
  coachEmail: "alexmilone@example.com",
  periodLabel: "Jul 1 – Jul 31, 2026",
  periodEndShort: "Jul 31",
  cage: CAGE,
  work: WORK,
};
