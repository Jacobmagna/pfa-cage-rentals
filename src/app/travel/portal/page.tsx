import type { Metadata } from "next";
import Link from "next/link";
import { requireTravelGuardian } from "@/travel/authz";
import { getTravelPortalData } from "@/travel/portal-data";
import { signOutTravel } from "./actions";

export const metadata: Metadata = {
  title: "Parent Portal — PFA Travel",
};

// The REAL travel parent home. A signed-in guardian sees their athlete(s) and
// each athlete's team(s). Read-only — athletes join via the accept flow in a
// later block; billing/messages/store are later blocks too.
//
// requireTravelGuardian() redirects any non-guardian viewer to /travel/signin,
// so the body only renders for an authenticated parent. Rendered inside the
// travel layout (near-black masthead + gold rule already supplied) at the
// layout's max-w-5xl width — no header re-added, not wrapped in a narrow card.
//
// Elevated travel skin (same as the auth screens): facility color tokens,
// SHARP rounded-md, flat (no shadows), 1px border-line, gold as accent only,
// credential/roster character (tracked-uppercase micro-labels), strong type.

export default async function TravelPortal() {
  const guardian = await requireTravelGuardian();
  const { athletes } = await getTravelPortalData(guardian.id);

  return (
    <div className="flex flex-1 flex-col">
      {/* Header row: welcome + a restrained secondary sign-out. */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold tracking-tight text-fg">
          Welcome, {guardian.firstName}
        </h1>
        <form action={signOutTravel}>
          <button
            type="submit"
            className="rounded-md border border-line bg-surface h-9 px-3 text-sm font-medium text-fg transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Sign out
          </button>
        </form>
      </div>

      {/* Section label: tracked-uppercase micro-label + a hairline rule. */}
      <div className="mt-8">
        <h2 className="text-[11px] uppercase tracking-[0.18em] font-semibold text-fg-subtle">
          Your Athletes
        </h2>
        <div className="mt-2 h-px w-full bg-line" />
      </div>

      {athletes.length === 0 ? (
        // Common first-load state: intentional, on-brand empty panel.
        <div className="mt-6 rounded-md border border-line bg-surface-2 p-8 text-center">
          <p className="text-base font-semibold text-fg">No athletes yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-fg-muted">
            Your player will appear here once PFA accepts them onto a team.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          {athletes.map((athlete) => {
            // Present-only meta chips (grad year, jersey #, positions).
            const meta: { label: string; value: string }[] = [];
            if (athlete.gradYear != null) {
              meta.push({ label: "Grad", value: String(athlete.gradYear) });
            }
            if (athlete.jerseyNo) {
              meta.push({ label: "Jersey", value: `#${athlete.jerseyNo}` });
            }
            if (athlete.positions) {
              meta.push({ label: "Positions", value: athlete.positions });
            }

            return (
              <article
                key={athlete.id}
                className="rounded-md border border-line border-l-2 border-l-yellow bg-surface p-5"
              >
                <h3 className="font-semibold text-fg">
                  {athlete.firstName} {athlete.lastName}
                </h3>

                {meta.length > 0 ? (
                  <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-fg-muted">
                    {meta.map((m) => (
                      <div key={m.label} className="flex items-baseline gap-1.5">
                        <dt className="text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                          {m.label}
                        </dt>
                        <dd className="text-fg-muted">{m.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {athlete.teams.length === 0 ? (
                  <p className="mt-4 text-sm text-fg-subtle">
                    Not yet rostered
                  </p>
                ) : (
                  <div className="mt-4 space-y-2">
                    <p className="text-[10px] uppercase tracking-[0.14em] font-semibold text-fg-subtle">
                      Teams
                    </p>
                    {athlete.teams.map((team) => (
                      <div
                        key={team.id}
                        className="rounded-md border border-line bg-page px-3 py-2"
                      >
                        <p className="text-sm font-bold text-fg">{team.name}</p>
                        {team.divisionName || team.locationName ? (
                          <p className="mt-0.5 text-xs text-fg-muted">
                            {[team.divisionName, team.locationName]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Primary next action: register a rostered player for a season / program. */}
      <Link
        href="/travel/portal/register"
        className="mt-8 flex items-center justify-between gap-4 rounded-md border border-line border-l-2 border-l-yellow bg-surface p-5 transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
      >
        <span>
          <span className="block font-semibold text-fg">
            Register for a season
          </span>
          <span className="mt-0.5 block text-sm text-fg-muted">
            Sign a player up for a program and see the amount due.
          </span>
        </span>
        <span className="text-gold" aria-hidden="true">
          &rarr;
        </span>
      </Link>

      {/* Understated hint at what's next — no links/buttons. */}
      <p className="mt-10 text-xs text-fg-subtle">
        Billing, messages &amp; team store are coming soon.
      </p>
    </div>
  );
}
