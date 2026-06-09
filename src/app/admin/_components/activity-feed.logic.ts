// Pure mapper for the admin Home "Recent activity" feed. Translates a raw
// audit-log (entityType, action) pair into a human label + a `kind` used to
// color the pill. Returns `null` for entity types coaches rarely touch so
// the feed stays focused on the three things that matter: cage rentals,
// program hours, and attendance.
export type ActivityKind =
  | "cage"
  | "program"
  | "attendance"
  | "joined"
  | "other";

export function describeActivity(
  entityType: string,
  action: "create" | "update" | "delete",
): { kind: ActivityKind; label: string } | null {
  switch (entityType) {
    case "session":
      return {
        kind: "cage",
        label:
          action === "create"
            ? "Logged rental"
            : action === "update"
              ? "Edited rental"
              : "Removed rental",
      };
    case "hour_log":
      return {
        kind: "program",
        label:
          action === "create"
            ? "Logged program hours"
            : action === "update"
              ? "Edited hours"
              : "Removed hours",
      };
    case "attendance_session":
      return {
        kind: "attendance",
        label:
          action === "create"
            ? "Took attendance"
            : action === "update"
              ? "Updated attendance"
              : "Cleared attendance",
      };
    default:
      return null; // coaches rarely touch other entities; keep the feed focused
  }
}
