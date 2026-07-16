import Link from "next/link";
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

      <nav className="mt-4 flex flex-wrap gap-3">
        <Link
          href="/travel/admin/applications"
          className="inline-flex items-center rounded-md border border-line bg-surface h-10 px-4 text-sm font-semibold text-fg transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          Applications / Tryouts
        </Link>
        <Link
          href="/travel/admin/products"
          className="inline-flex items-center rounded-md border border-line bg-surface h-10 px-4 text-sm font-semibold text-fg transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          Products
        </Link>
        <Link
          href="/travel/admin/registrations"
          className="inline-flex items-center rounded-md border border-line bg-surface h-10 px-4 text-sm font-semibold text-fg transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          Registrations &amp; Dues
        </Link>
        <Link
          href="/travel/admin/payments"
          className="inline-flex items-center rounded-md border border-line bg-surface h-10 px-4 text-sm font-semibold text-fg transition-colors hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          Payments &amp; Refunds
        </Link>
      </nav>
    </div>
  );
}
