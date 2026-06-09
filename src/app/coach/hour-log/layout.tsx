import { requireSession } from "@/lib/authz";
import { HourLogSubnav } from "./_components/hour-log-subnav";

// Coach Hour Log section shell (QA10 W3.7). Renders the shared
// <h1>Hour Log</h1> + the two-tab sub-nav (Log hours | History) above
// every hour-log sub-route, so the header stays put while the coach
// switches tabs. Each child page renders only its own body.
//
// Auth-gates with requireSession() so the chrome never renders for a
// signed-out user; each child page still calls requireSession() itself.
export default async function CoachHourLogLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireSession();

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Work Log</h1>
      <HourLogSubnav />
      <div>{children}</div>
    </div>
  );
}
