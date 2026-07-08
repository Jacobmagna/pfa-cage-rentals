import { requireTravelAccess } from "@/travel/authz";

// Guarded travel operator landing (PLACEHOLDER). requireTravelAccess() runs
// FIRST — it gates the page (redirecting unauthenticated/unauthorized users to
// /travel/signin) and returns the authed travel session. The real operator
// dashboard/nav + data are later scoped blocks; nothing beyond this confirming
// placeholder is built here. Rendered inside the existing travel shell
// (src/app/travel/layout.tsx), so no page chrome is repeated.

export default async function TravelAdminPage() {
  const session = await requireTravelAccess();

  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-bold tracking-tight text-fg">
        Travel — Operator
      </h1>
      <p className="text-sm text-fg-muted">
        You&apos;re signed in as {session.user.email} with travel operator
        access.
      </p>
    </div>
  );
}
