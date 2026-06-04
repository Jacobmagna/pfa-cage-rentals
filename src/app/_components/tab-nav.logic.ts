export type TabKey =
  | "home"
  | "cage"
  | "hour-log"
  | "attendance"
  | "schedule"
  | "records";

// Admin sections that belong to the new top-level "Billing & Records" tab
// (QA5). These surfaces aren't cage-rental-specific, so they were lifted off
// the Cage Rentals dashboard into their own tab at /admin/records.
const RECORDS_SECTIONS = new Set([
  "records",
  "coaches",
  "reports",
  "audit",
  "payments",
  "import",
  "settings",
]);

/**
 * Determine the active top-level tab from the current pathname.
 *
 * Rule: look at the path segment immediately after the role base
 * (`/admin` or `/coach`). If it is `hour-log` -> Hour Log; if `attendance`
 * -> Attendance. For admins, the org-record sections (coaches, reports,
 * payments, audit, import, settings, records) light up the new "Billing &
 * Records" tab (QA5). Everything else (`/admin/cage-rentals`,
 * `/admin/sessions`, admin `/admin/schedule`, etc.) -> Cage Rentals.
 *
 * The admin landing (`/admin` exactly, with `role === "admin"`) is the new
 * Home tab (QA4-C1). The coach root and any no-role root stay on Cage
 * Rentals for back-compat — existing one-arg callers of `activeTab("/admin")`
 * must keep getting `"cage"`.
 *
 * `schedule` is COACH-ONLY: it lights up only when `role === "coach"` and
 * the section is `schedule` (`/coach/schedule`). Admin reaches its schedule
 * via `/admin/schedule`, which has no top tab of its own and must keep
 * falling through to Cage Rentals. The `role` arg is optional so existing
 * one-arg callers keep their original behavior (admin / no-role on
 * `/…/schedule` → Cage Rentals).
 *
 * The Billing & Records grouping is gated on `role === "admin"`, so coach
 * routes and existing no-role callers are unaffected (back-compat:
 * `activeTab("/admin/coaches/123")` with no role stays `"cage"`).
 *
 * Cage Rentals is the fallback and must not light up for hour-log /
 * attendance routes.
 */
export function activeTab(pathname: string, role?: "admin" | "coach"): TabKey {
  const segments = pathname.split("/").filter(Boolean);
  const section = segments[1];
  if (section === "hour-log") return "hour-log";
  if (section === "attendance") return "attendance";
  if (section === "schedule" && role === "coach") return "schedule";
  // Admin landing (/admin exactly) is Home; coach root + no-role root stay cage (back-compat).
  if (section === undefined) return role === "admin" ? "home" : "cage";
  // Admin org-record sections → Billing & Records (no-role/coach unaffected).
  if (role === "admin" && section && RECORDS_SECTIONS.has(section))
    return "records";
  // cage-rentals, sessions, admin schedule, etc. → Cage Rentals.
  return "cage";
}
