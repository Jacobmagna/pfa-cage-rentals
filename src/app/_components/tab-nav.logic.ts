export type TabKey = "cage" | "hour-log" | "attendance";

/**
 * Determine the active top-level tab from the current pathname.
 *
 * Rule: look at the path segment immediately after the role base
 * (`/admin` or `/coach`). If it is `hour-log` -> Hour Log; if `attendance`
 * -> Attendance; otherwise (section root and all other cage-rentals
 * sub-routes like `/admin/sessions`, `/admin/coaches/123`) -> Cage Rentals.
 *
 * Cage Rentals is the fallback and must not light up for hour-log /
 * attendance routes.
 */
export function activeTab(pathname: string): TabKey {
  const segments = pathname.split("/").filter(Boolean);
  // segments[0] is the role base ("admin" | "coach"); segments[1] is the section.
  const section = segments[1];

  if (section === "hour-log") return "hour-log";
  if (section === "attendance") return "attendance";
  return "cage";
}
