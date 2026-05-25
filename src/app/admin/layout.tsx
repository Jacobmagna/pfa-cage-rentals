import { AppShell } from "@/app/_components/app-shell";

// Admin section shell. Wrapping AppShell here (instead of in each
// page.tsx) means the nav + footer render before the page's async
// data resolves, so loading.tsx files render INSIDE the shell rather
// than replacing it — the nav stays visible while skeletons stream.
//
// requireRole("admin") still runs inside each page.tsx (the layout
// doesn't auth-gate); pages can choose whether they need admin vs
// admin-or-coach. The shell calls auth() for the display name + sign-
// out form but doesn't enforce a role.

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <AppShell role="admin">{children}</AppShell>;
}
