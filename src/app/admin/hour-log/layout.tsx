import { requireRole } from "@/lib/authz";
import { HourLogSubnav } from "./_components/hour-log-subnav";

// Hour Log section shell (QA2-8 — pure additive nav chrome). Renders
// ONLY the route-based sub-nav (Hours | Program Schedule) above every
// hour-log sub-route. It deliberately renders NO <h1>/eyebrow: the
// hours table (/admin/hour-log/page.tsx) and the program-schedule grid
// (/admin/hour-log/schedule/page.tsx) each render their own Back link +
// header, and the hours page must stay byte-for-byte unchanged. Each
// child page still calls requireRole("admin") itself; this layout
// auth-gates too so the chrome never renders for a non-admin.
export default async function HourLogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole("admin");

  return (
    <div className="space-y-6">
      <HourLogSubnav />
      <div>{children}</div>
    </div>
  );
}
