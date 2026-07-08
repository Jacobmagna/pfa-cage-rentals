import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTravelViewer } from "@/travel/authz";
import { AuthShell } from "../_components/auth-shell";
import { requestTravelMagicLink, signInTravelParent } from "./actions";
import { TravelGoogleSignInButton } from "./_components/travel-google-button";

export const metadata: Metadata = {
  title: "Sign in — PFA Travel",
};

// Travel sign-in. Two clearly separated subjects:
//   • PARENTS  → email + password (signInWithPassword → guardian portal).
//   • PFA STAFF → Google + magic-link (the admin/operator surface).
// Renders inside the existing travel layout (src/app/travel/layout.tsx) in the
// sharper travel skin via AuthShell.

type SearchParams = Promise<{
  error?: string;
  perror?: string;
  reset?: string;
}>;

// Magic-link / staff error copy (existing).
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
  "Something went wrong signing in. Try again, or use the other method below.";

// Parent password error copy (distinct ?perror param so it never collides with
// the magic-link copy above).
const PERROR_COPY: Record<string, string> = {
  invalid: "Email or password is incorrect.",
  unclaimed:
    "Set up your account first — check your email for your setup link.",
  unverified:
    "Please verify your email — check your inbox for the link.",
  weak_password: "Password must be at least 8 characters.",
};

export default async function TravelSignIn({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // If already signed into travel, skip the form — route each subject kind to
  // its own surface.
  const viewer = await getTravelViewer().catch(() => null);
  if (viewer?.kind === "guardian") redirect("/travel/portal");
  if (viewer?.kind === "user") redirect("/travel/admin");

  const { error, perror, reset } = await searchParams;
  const errorMessage = error ? ERROR_COPY[error] ?? ERROR_FALLBACK : null;
  const parentError = perror ? PERROR_COPY[perror] ?? ERROR_FALLBACK : null;

  return (
    <AuthShell heading="Sign in">
      {reset ? (
        <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-muted">
          Password updated — sign in with your new password.
        </p>
      ) : null}

      {/* Parents: email + password. */}
      <div className={reset ? "mt-4" : undefined}>
        <h2 className="text-sm font-semibold text-fg">Parents</h2>

        {parentError ? (
          <p
            role="alert"
            className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {parentError}
          </p>
        ) : null}

        <form action={signInTravelParent} className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <label
              htmlFor="parent-email"
              className="block text-sm font-medium text-fg"
            >
              Email
            </label>
            <input
              id="parent-email"
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="parent-password"
              className="block text-sm font-medium text-fg"
            >
              Password
            </label>
            <input
              id="parent-password"
              type="password"
              name="password"
              required
              autoComplete="current-password"
              placeholder="Your password"
              className="w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
            />
          </div>
          <button
            type="submit"
            className="w-full rounded-md bg-yellow text-gold-ink h-10 px-4 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Sign in
          </button>
        </form>

        <p className="mt-3 text-sm text-fg-muted">
          <Link
            href="/travel/forgot"
            className="font-medium text-fg underline underline-offset-2 hover:text-fg-muted"
          >
            Forgot password?
          </Link>
        </p>
      </div>

      {/* Divider between the two subjects. */}
      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs text-fg-subtle">PFA staff</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      {/* PFA staff: Google + magic-link. */}
      <div className="space-y-3">
        {errorMessage ? (
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
          >
            {errorMessage}
          </p>
        ) : null}

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
            className="w-full rounded-md border border-line bg-page px-3 h-10 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          />
          <button
            type="submit"
            className="w-full rounded-md border border-line bg-surface text-fg h-10 px-4 text-sm font-medium transition-colors hover:bg-page focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          >
            Email me a sign-in link
          </button>
        </form>
      </div>
    </AuthShell>
  );
}
