import { redirect } from "next/navigation";
import { requireRole } from "@/lib/authz";

// The Attendance section is a route-based sub-tab shell (DEC-22). The
// section root redirects to the first sub-tab; the sub-nav itself lives
// in layout.tsx so it renders around every attendance sub-route.
export default async function AdminAttendancePage() {
  await requireRole("admin");
  redirect("/admin/attendance/roster");
}
