import { requireRole } from "@/lib/authz";
import { AttendanceSubnav } from "./_components/attendance-subnav";

// Attendance section shell (DEC-22). Renders the page <h1> + the
// route-based sub-nav (Roster | Attendance by Program) around every
// attendance sub-route, so the sub-tabs stay visible while a child
// page's data streams. Each child page still calls requireRole("admin")
// itself; this layout auth-gates too so the chrome never renders for a
// non-admin.
export default async function AttendanceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole("admin");

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Attendance</h1>
      </div>

      <AttendanceSubnav />

      <div>{children}</div>
    </div>
  );
}
