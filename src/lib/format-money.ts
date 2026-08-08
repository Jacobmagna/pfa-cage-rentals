// Whole-dollar money formatter. Renders cents as a "$1,234" string with
// no fractional digits and en-US grouping. Shared by the admin dashboard
// stat hero and (QA4) the Hour Log + Home surfaces so the rounded-dollar
// presentation stays identical everywhere. Components that need cents
// precision keep their own local formatter — this one rounds to whole
// dollars by design.
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

/**
 * EXACT money — "$1,234.50". Same grouping as `formatDollars`, but never
 * drops cents.
 *
 * Use this wherever a figure is a payroll or receivable AMOUNT rather than
 * a glanceable magnitude. `formatDollars` rounding a payout to the dollar
 * put the Work Log's "Owed to coaches" card a few cents away from every
 * preview and workbook quoting the same money (reports-tabs SPEC §10) —
 * two different numbers for one figure reads as a bug in the money, which
 * is expensive on a screen people trust to pay people.
 */
export function formatDollarsExact(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
