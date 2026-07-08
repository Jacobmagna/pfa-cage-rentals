import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@/travel/auth";
import { requestTravelMagicLink } from "./actions";
import { TravelGoogleSignInButton } from "./_components/travel-google-button";

export const metadata: Metadata = {
  title: "Sign in — PFA Travel",
};

// Minimal travel sign-in page. Mirrors the facility sign-in MECHANISM (a
// Google button + a magic-link email form), travel-branded and minimal, and
// renders inside the existing travel layout (src/app/travel/layout.tsx). Real
// design is a later scoped task.

type SearchParams = Promise<{ error?: string }>;

const ERROR_COPY: Record<string, string> = {
  "missing-email": "Please enter your email address.",
  "email-limit":
    "Too many sign-in attempts for this email. Try again in an hour.",
  "ip-limit":
    "Too many sign-in attempts from your network. Try again in an hour.",
  "send-failed":
    "We couldn't send your sign-in link right now. Please try again in a moment.",
  OAuthAccountNotLinked:
    "This email is already linked to another sign-in method. Try the other option above.",
  Verification:
    "That sign-in link expired or was already used. Request a new one.",
  AccessDenied:
    "This email isn't authorized for PFA Travel yet. Ask PFA to add you, then try again.",
};

const ERROR_FALLBACK =
  "Something went wrong signing in. Try again, or use the other method above.";

export default async function TravelSignIn({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // If already signed into travel, skip the form.
  const session = await auth().catch(() => null);
  if (session?.user?.id) redirect("/travel");

  const { error } = await searchParams;
  const errorMessage = error
    ? ERROR_COPY[error] ?? ERROR_FALLBACK
    : null;

  return (
    <section className="flex flex-1 flex-col items-center justify-center py-8">
      <div className="w-full max-w-sm">
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          PFA Travel
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg">
          Sign in
        </h1>

        {errorMessage ? (
          <p
            role="alert"
            className="mt-4 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg-muted"
          >
            {errorMessage}
          </p>
        ) : null}

        <div className="mt-6 space-y-3">
          <TravelGoogleSignInButton />

          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs text-fg-subtle">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <form action={requestTravelMagicLink} className="space-y-3">
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full rounded-lg border border-line bg-page px-3 h-10 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
            />
            <button
              type="submit"
              className="w-full rounded-lg border border-line bg-surface text-fg h-10 px-4 text-sm font-medium transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
            >
              Email me a sign-in link
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
