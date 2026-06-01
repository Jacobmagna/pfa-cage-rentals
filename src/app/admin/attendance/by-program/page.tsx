import { CalendarCheck } from "lucide-react";
import { requireRole } from "@/lib/authz";

// Placeholder for a later feature (attendance taking + per-program
// rollups). Auth-gated so a non-admin never reaches it. The <h1> + sub-
// nav are rendered by the section layout.
export default async function AttendanceByProgramPage() {
  await requireRole("admin");

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface py-16 text-center">
      <CalendarCheck className="h-8 w-8 text-gold" aria-hidden="true" />
      <p className="text-fg-muted">Attendance by Program — coming soon</p>
    </div>
  );
}
