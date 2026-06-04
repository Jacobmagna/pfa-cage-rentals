export type TabKey = "home" | "cage" | "hour-log" | "attendance" | "schedule";

/**
 * Determine the active top-level tab from the current pathname.
 *
 * Rule: look at the path segment immediately after the role base
 * (`/admin` or `/coach`). If it is `hour-log` -> Hour Log; if `attendance`
 * -> Attendance; otherwise (all other cage-rentals sub-routes like
 * `/admin/cage-rentals`, `/admin/sessions`, `/admin/coaches/123`) -> Cage
 * Rentals.
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
  // cage-rentals, sessions, coaches, payments, reports, admin schedule, etc. → Cage Rentals.
  return "cage";
}
