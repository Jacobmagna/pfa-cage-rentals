import type { Metadata } from "next";
import { listPublicTeams } from "@/travel/applications";
import { submitApplication } from "./actions";

export const metadata: Metadata = {
  title: "Request to Join — PFA Travel",
};

// Public "Request to Join / Tryout" application. NO auth, NO account, NO
// payment — it captures a pending travel_applications row an operator reviews
// later. Reachable without a travel session (only /travel/admin + /travel/portal
// are guarded); this page adds NO guard.
//
// States:
//   • ?submitted=1        → confirmation panel (whole-page success state).
//   • ?error=<code>       → error banner above the form.
//   • ?team=<id>          → pre-selects that team in the <select>.
//
// Skin: replicates AuthShell's treatment (gold top-accent + crest + eyebrow +
// bold heading) at a wider width, since this form has more fields than the
// auth screens. Facility tokens only; sharp rounded-md; flat (no shadow).

type SearchParams = Promise<{
  team?: string;
  submitted?: string;
  error?: string;
}>;

const ERROR_COPY: Record<string, string> = {
  rate: "Too many submissions — please try again in a bit.",
  missing: "Please fill in all required fields.",
  email: "Please enter a valid email address.",
};

// Shared field-label class: credential style (tracked uppercase micro-label).
const LABEL = "block text-[11px] uppercase tracking-wider font-semibold text-fg-muted";
// Shared input class: sharp, flat, hairline border, gold focus ring.
const INPUT =
  "w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40";

// Card shell — AuthShell's exact treatment, widened for the longer form.
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
          PFA Travel / Tryouts
        </p>
        {children}
      </div>
    </section>
  );
}

export default async function TravelApply({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { team, submitted, error } = await searchParams;

  // SUCCESS state — the whole page becomes a confirmation panel.
  if (submitted) {
    return (
      <Card>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-fg">
          Application received
        </h1>
        <div className="mt-7 rounded-md border border-line bg-surface-2 px-4 py-4">
          <p className="text-sm text-fg-muted">
            Thanks — PFA will review your request and follow up by email. Watch
            your inbox.
          </p>
        </div>
      </Card>
    );
  }

  const teams = await listPublicTeams();
  const errorMessage = error ? ERROR_COPY[error] : null;

  // Build the human label for each team option: "Name — Cohort · Division ·
  // Location", skipping any missing parts.
  const teamLabel = (t: (typeof teams)[number]) => {
    const parts = [t.cohort, t.divisionName, t.locationName].filter(Boolean);
    return parts.length ? `${t.name} — ${parts.join(" · ")}` : t.name;
  };

  return (
    <Card>
      <h1 className="mt-1 text-2xl font-bold tracking-tight text-fg">
        Request to Join
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Tell us about your athlete and we&apos;ll be in touch about tryouts.
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

        <form action={submitApplication} className="space-y-5">
          {/* Team / age group */}
          <div className="space-y-1.5">
            <label htmlFor="teamId" className={LABEL}>
              Team / age group
            </label>
            <select
              id="teamId"
              name="teamId"
              defaultValue={team ?? ""}
              disabled={teams.length === 0}
              className={`${INPUT} disabled:opacity-60`}
            >
              <option value="">Select a team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {teamLabel(t)}
                </option>
              ))}
            </select>
            {teams.length === 0 ? (
              <p className="text-xs text-fg-subtle">
                Teams will be listed here soon.
              </p>
            ) : null}
          </div>

          {/* Athlete */}
          <fieldset className="space-y-3 border-t border-line pt-4">
            <legend className="text-[11px] uppercase tracking-wider font-semibold text-fg-subtle">
              Athlete
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="athleteFirstName" className={LABEL}>
                  First name
                </label>
                <input
                  id="athleteFirstName"
                  name="athleteFirstName"
                  required
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="athleteLastName" className={LABEL}>
                  Last name
                </label>
                <input
                  id="athleteLastName"
                  name="athleteLastName"
                  required
                  autoComplete="off"
                  className={INPUT}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="athleteGradYear" className={LABEL}>
                  Grad year
                </label>
                <input
                  id="athleteGradYear"
                  name="athleteGradYear"
                  type="number"
                  inputMode="numeric"
                  min={2020}
                  max={2040}
                  placeholder="2028"
                  className={INPUT}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="athletePositions" className={LABEL}>
                  Positions
                </label>
                <input
                  id="athletePositions"
                  name="athletePositions"
                  placeholder="SS, 2B"
                  className={INPUT}
                />
              </div>
            </div>
          </fieldset>

          {/* Parent / guardian */}
          <fieldset className="space-y-3 border-t border-line pt-4">
            <legend className="text-[11px] uppercase tracking-wider font-semibold text-fg-subtle">
              Parent / guardian
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="parentFirstName" className={LABEL}>
                  First name
                </label>
                <input
                  id="parentFirstName"
                  name="parentFirstName"
                  required
                  autoComplete="given-name"
                  className={INPUT}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="parentLastName" className={LABEL}>
                  Last name
                </label>
                <input
                  id="parentLastName"
                  name="parentLastName"
                  required
                  autoComplete="family-name"
                  className={INPUT}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="parentEmail" className={LABEL}>
                  Email
                </label>
                <input
                  id="parentEmail"
                  name="parentEmail"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  className={INPUT}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="parentPhone" className={LABEL}>
                  Phone
                </label>
                <input
                  id="parentPhone"
                  name="parentPhone"
                  type="tel"
                  autoComplete="tel"
                  placeholder="(555) 555-5555"
                  className={INPUT}
                />
              </div>
            </div>
          </fieldset>

          {/* Message */}
          <div className="space-y-1.5 border-t border-line pt-4">
            <label htmlFor="message" className={LABEL}>
              Message
            </label>
            <textarea
              id="message"
              name="message"
              rows={3}
              placeholder="Anything you'd like us to know?"
              className="w-full rounded-md border border-line bg-page px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-md bg-yellow text-gold-ink h-10 px-4 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Submit request
          </button>
        </form>
      </div>
    </Card>
  );
}
