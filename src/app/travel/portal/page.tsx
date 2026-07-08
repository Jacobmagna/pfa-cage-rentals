import type { Metadata } from "next";
import { requireTravelGuardian } from "@/travel/authz";
import { signOutTravel } from "./actions";

export const metadata: Metadata = {
  title: "Parent Portal — PFA Travel",
};

// Minimal guarded parent-portal STUB. `requireTravelGuardian()` redirects any
// non-guardian viewer to /travel/signin, so the body below only renders for an
// authenticated parent. The real portal is a later task — this is intentionally
// minimal, but on-brand in the SHARPER TRAVEL SKIN: institutional/restrained,
// `rounded-md` (tighter than the signin page's `rounded-lg`), crisp 1px
// `border-line`, flat (no shadows), gold reserved for the primary action.

export default async function TravelPortal() {
  const guardian = await requireTravelGuardian();

  return (
    <section className="flex flex-1 flex-col items-center justify-center py-8">
      <div className="w-full max-w-md rounded-md border border-line bg-surface p-6">
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          PFA Travel
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg">
          PFA Travel — Parent Portal
        </h1>
        <p className="mt-3 text-sm text-fg-muted">
          Signed in as {guardian.firstName} {guardian.lastName} ({guardian.email})
        </p>

        <form action={signOutTravel} className="mt-6">
          <button
            type="submit"
            className="rounded-md border border-line bg-yellow px-4 h-10 text-sm font-semibold text-gold-ink transition-colors hover:bg-yellow/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Sign out
          </button>
        </form>
      </div>
    </section>
  );
}
