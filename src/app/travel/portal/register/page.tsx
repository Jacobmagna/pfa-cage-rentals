import type { Metadata } from "next";
import Link from "next/link";
import { requireTravelGuardian } from "@/travel/authz";
import {
  listRegisterableAthletesForGuardian,
  listRegisterableTravelProducts,
} from "@/travel/registration";
import { RegisterForm } from "./_components/register-form";

export const metadata: Metadata = {
  title: "Register a Player — PFA Travel",
};

// Block 3c — the parent-facing registration screen. A signed-in travel GUARDIAN
// registers one of their OWN rostered athletes for a season/team-dues (or camp /
// clinic / program) product and sees the amount owed. Wires the Block-3b engine
// (registration.ts) to a UI.
//
// GUARD: requireTravelGuardian() — the SAME guard the portal home uses — bounces
// any non-guardian (facility admin / no session) to /travel/signin, so the body
// only renders for an authenticated parent. Rendered inside the travel layout
// (near-black masthead + gold rule) at max-w-5xl.
//
// States:
//   • no athletes on the account → an on-brand empty panel, no form.
//   • ?error=<code>             → error banner above the form.
//   • ?done=1&amt=<cents>       → whole-page confirmation ("You're registered.").
//
// Skin: replicates the apply page's Card treatment (gold top-accent + crest +
// eyebrow + bold heading) for the panels; facility tokens only; sharp rounded-md;
// flat (no shadow).

type SearchParams = Promise<{
  error?: string;
  done?: string;
  amt?: string;
}>;

const ERROR_COPY: Record<string, string> = {
  athlete_not_owned: "That player isn't on your account.",
  product_unavailable: "That program isn't available right now.",
  tier_required: "Please choose an option for this program.",
  already_enrolled: "That player is already registered for this program.",
  no_guardian: "Please sign in again and retry.",
  rate: "Please wait a moment and try again.",
  missing: "Please pick a player and a program.",
};

// Format cents → "$1,234.00" for DISPLAY only.
function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

// Card shell — the apply page's exact treatment (gold top-accent + crest +
// eyebrow), widened for the form.
function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center py-8">
      <div className="w-full max-w-lg rounded-md border border-line border-t-2 border-t-yellow bg-surface p-7">
        <span className="flex size-11 items-center justify-center rounded-md bg-[#0a0a0a]">
          <span className="text-gold text-[11px] font-bold tracking-[0.15em]">
            PFA
          </span>
        </span>

        <p className="mt-6 text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          PFA Travel / Registration
        </p>
        {children}
      </div>
    </section>
  );
}

export default async function TravelRegister({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const guardian = await requireTravelGuardian();
  const { error, done, amt } = await searchParams;

  // SUCCESS state — the whole page becomes a confirmation panel. `amt` is the
  // amount owed in cents; parse defensively and ignore if malformed.
  if (done) {
    const amtCents = amt ? Number.parseInt(amt, 10) : NaN;
    const amtValid = Number.isInteger(amtCents) && amtCents >= 0;

    return (
      <Card>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-fg">
          You&apos;re registered.
        </h1>
        <div className="mt-7 rounded-md border border-line bg-surface-2 px-4 py-4">
          {amtValid ? (
            <>
              <p className="text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                Amount due
              </p>
              <p className="mt-1 text-2xl font-bold text-fg">
                {formatUsd(amtCents)}
              </p>
              <p className="mt-3 text-sm text-fg-muted">
                You&apos;ll be able to pay your deposit to lock the spot shortly.
              </p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">
              Your player is registered. You&apos;ll be able to pay your deposit
              to lock the spot shortly.
            </p>
          )}
        </div>

        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            href="/travel/portal/register"
            className="rounded-md border border-line bg-surface h-10 px-4 inline-flex items-center text-sm font-medium text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Register another
          </Link>
          <Link
            href="/travel/portal"
            className="rounded-md border border-line bg-surface h-10 px-4 inline-flex items-center text-sm font-medium text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Back to portal
          </Link>
        </div>
      </Card>
    );
  }

  const [athletes, products] = await Promise.all([
    listRegisterableAthletesForGuardian(guardian.id),
    listRegisterableTravelProducts(),
  ]);

  // EMPTY state — no players on the account yet, so no form is shown.
  if (athletes.length === 0) {
    return (
      <Card>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-fg">
          Register a player
        </h1>
        <div className="mt-7 rounded-md border border-line bg-surface-2 px-4 py-4">
          <p className="text-sm text-fg-muted">
            No players on your account yet — once your athlete is accepted onto a
            team you can register them here.
          </p>
        </div>
        <div className="mt-7">
          <Link
            href="/travel/portal"
            className="rounded-md border border-line bg-surface h-10 px-4 inline-flex items-center text-sm font-medium text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Back to portal
          </Link>
        </div>
      </Card>
    );
  }

  const errorMessage = error ? ERROR_COPY[error] : null;

  return (
    <Card>
      <h1 className="mt-1 text-2xl font-bold tracking-tight text-fg">
        Register a player
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Pick your player and a program to see the amount due.
      </p>

      <div className="mt-7">
        {errorMessage ? (
          <p
            role="alert"
            className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {errorMessage}
          </p>
        ) : null}

        <RegisterForm athletes={athletes} products={products} />
      </div>
    </Card>
  );
}
