// Whole-dollar money formatter. Renders cents as a "$1,234" string with
// no fractional digits and en-US grouping. Shared by the admin dashboard
// stat hero and (QA4) the Hour Log + Home surfaces so the rounded-dollar
// presentation stays identical everywhere. Components that need cents
// precision keep their own local formatter — this one rounds to whole
// dollars by design.
export function formatDollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}
