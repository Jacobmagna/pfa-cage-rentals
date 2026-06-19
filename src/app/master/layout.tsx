import { requireScheduleAccess } from "@/lib/authz";
import { AppShell } from "@/app/_components/app-shell";

// Master Schedule Manager (Add-On Part 1). Guarded surface for admins +
// schedule-manager coaches. Renders the shell matching the user's ACTUAL
// role (admin keeps admin chrome, a flagged coach keeps coach chrome), each
// with the Master tab. Children are the cage + work schedule grids reusing
// the exact admin components against the same live tables.
export default async function MasterLayout({ children }: { children: React.ReactNode }) {
  const session = await requireScheduleAccess();
  return <AppShell role={session.user.role}>{children}</AppShell>;
}
