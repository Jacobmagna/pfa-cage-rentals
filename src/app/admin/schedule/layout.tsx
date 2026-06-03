import { requireRole } from "@/lib/authz";

// Schedule section shell. After QA2-8 the program schedule moved out
// from under Cage Rentals to a sub-tab under Hour Log, so the cage
// schedule no longer has a sub-nav — this layout is now just the
// auth-gating wrapper. It renders NO <h1>/eyebrow: the cage page
// (/admin/schedule/page.tsx) renders its own Back link + date header and
// must stay byte-for-byte unchanged. The child page still calls
// requireRole("admin") itself; this layout auth-gates too.
export default async function ScheduleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole("admin");

  return <div className="space-y-6">{children}</div>;
}
