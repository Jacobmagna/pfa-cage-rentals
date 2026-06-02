import { requireRole } from "@/lib/authz";
import { ScheduleSubnav } from "./_components/schedule-subnav";

// Schedule section shell (DEC-17 — pure additive nav chrome). Renders
// ONLY the route-based sub-nav (Cage Rentals | Programs) above every
// schedule sub-route. It deliberately renders NO <h1>/eyebrow: the cage
// page (/admin/schedule/page.tsx) and the programs page each render
// their own Back link + date header, and the cage page must stay
// byte-for-byte unchanged. Each child page still calls
// requireRole("admin") itself; this layout auth-gates too so the chrome
// never renders for a non-admin.
export default async function ScheduleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole("admin");

  return (
    <div className="space-y-6">
      <ScheduleSubnav />
      <div>{children}</div>
    </div>
  );
}
