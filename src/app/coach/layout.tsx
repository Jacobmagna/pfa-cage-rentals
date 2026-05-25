import { AppShell } from "@/app/_components/app-shell";

// Coach section shell — see src/app/admin/layout.tsx for the
// rationale (loading.tsx renders inside the shell).

export default function CoachLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell role="coach">{children}</AppShell>;
}
