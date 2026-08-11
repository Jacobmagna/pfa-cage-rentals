// Sub-tabs for /admin/reports — Cage rentals · Work hours · Payments
// (reports-tabs SPEC §3). These replace the old "Scope" checkboxes.
//
// Modeled on hour-log-subnav.tsx (gold underline, aria-current="page",
// focus ring, AA semantic tokens) with one difference: those sub-navs
// switch ROUTE, these switch a query param on the same route, because
// the filter bar above is shared and must survive a tab change. That
// also means this is a plain SERVER component — the page already knows
// the active tab, so there is no client state and no "use client".
//
// Each href = the current filters + this tab. `filtersToQueryString`
// carries no `tab` of its own (see filters.ts), so appending here is the
// only place a tab enters a URL.

import Link from "next/link";
import {
  REPORT_TABS,
  reportTabLabel,
  type ReportTab,
} from "@/lib/reports/tabs";

export function ReportsTabs({
  activeTab,
  filterQueryString,
  basePath = "/admin/reports",
}: {
  activeTab: ReportTab;
  /** Current filters, already serialized. Must NOT contain `tab`. */
  filterQueryString: string;
  /**
   * Route the tabs point at. Defaults to the real page; parameterised only so
   * the statement design mock can render this component verbatim instead of
   * growing a second copy of the tab strip that would drift from it.
   */
  basePath?: string;
}) {
  return (
    <nav aria-label="Report sections" className="border-b border-line mb-6">
      <ul className="flex gap-1 overflow-x-auto whitespace-nowrap -mb-px">
        {REPORT_TABS.map((tab) => {
          const isActive = tab === activeTab;
          return (
            <li key={tab}>
              <Link
                href={`${basePath}?${filterQueryString}&tab=${tab}`}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-flex items-center px-3 sm:px-4 py-3 text-sm border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded-sm",
                  isActive
                    ? "border-gold text-fg font-semibold"
                    : "border-transparent text-fg-muted font-medium hover:text-fg",
                ].join(" ")}
              >
                {reportTabLabel(tab)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
