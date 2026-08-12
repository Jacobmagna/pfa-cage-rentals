// The /admin/reports sub-tab selector (reports-tabs SPEC §3).
//
// Deliberately NOT part of NormalizedFilters, and that separation is a
// safety property rather than tidiness: the tab picks which VIEW renders,
// it must never narrow what is fetched or exported. The download route
// builds one workbook containing every category regardless of the tab on
// screen (SPEC §5), so keeping `tab` out of the filter object makes it
// structurally impossible for a selected tab to leak into a query or a
// sheet. `filtersToQueryString` stays tab-free for the same reason — the
// tab nav appends `tab` itself when building its links.
//
// The tab lives in the URL so links are shareable and Back works,
// matching how the filters already behave.

export const REPORT_TABS = ["cage", "work", "payments", "statements"] as const;

export type ReportTab = (typeof REPORT_TABS)[number];

/** Landing tab — the cage-rental view this page has always shown. */
export const DEFAULT_REPORT_TAB: ReportTab = "cage";

const REPORT_TAB_LABEL: Record<ReportTab, string> = {
  cage: "Cage rentals",
  work: "Work hours",
  payments: "Payments",
  // payment-statement SPEC §8: the statement lives HERE rather than on the
  // coach page. Reports is the screen Mark actually works from — it is where
  // he decides who owes him and who he owes — so sending him to a different
  // top-level tab to read a statement breaks the loop he is already in. It
  // also puts the RANGED+NETTED view in the same place as the ranged-but-gross
  // one, which is the whole point of the feature (SPEC §1b).
  statements: "Statements",
};

export function reportTabLabel(tab: ReportTab): string {
  return REPORT_TAB_LABEL[tab];
}

/**
 * Resolves the `tab` query param to a known tab. Anything unrecognized —
 * absent, empty, a typo, a hand-edited URL, or a repeated param — falls
 * back to the default rather than rendering an empty page. Accepts both
 * input shapes the page and route handlers produce (`string | string[]`).
 */
export function normalizeReportTab(
  input: string | string[] | undefined,
): ReportTab {
  const raw = (Array.isArray(input) ? input[0] : input)?.trim();
  return isReportTab(raw) ? raw : DEFAULT_REPORT_TAB;
}

function isReportTab(v: string | undefined): v is ReportTab {
  return v !== undefined && (REPORT_TABS as readonly string[]).includes(v);
}
