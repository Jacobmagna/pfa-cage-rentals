import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { claimTravelAccount } from "./actions";

export const metadata: Metadata = {
  title: "Set up your account — PFA Travel",
};

// Travel account claim. A parent lands here from the emailed setup link
// (?email=&token=), chooses their password, and is logged into the portal.
// Missing email/token → an invalid-link state (no form). Renders in the sharper
// travel skin via AuthShell.

type SearchParams = Promise<{
  email?: string;
  token?: string;
  error?: string;
}>;

const ERROR_COPY: Record<string, string> = {
  mismatch: "Those passwords don't match. Please re-enter them.",
  bad_token:
    "This setup link is invalid or expired. Ask PFA to resend it.",
  weak_password: "Password must be at least 8 characters.",
};

const ERROR_FALLBACK =
  "Something went wrong setting up your account. Please try again.";

export default async function TravelClaim({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { email, token, error } = await searchParams;

  // Missing link params → invalid-link state.
  if (!email || !token) {
    return (
      <AuthShell heading="Set up your account">
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          This setup link is invalid or incomplete. Ask PFA to resend it.
        </p>
        <p className="mt-4 text-sm text-fg-muted">
          <Link
            href="/travel/signin"
            className="font-medium text-fg underline underline-offset-2 hover:text-fg-muted"
          >
            Back to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  const errorMessage = error ? ERROR_COPY[error] ?? ERROR_FALLBACK : null;

  return (
    <AuthShell
      heading="Set up your account"
      subheading="Choose a password to finish setting up your PFA Travel account."
    >
      {errorMessage ? (
        <p
          role="alert"
          className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      <form action={claimTravelAccount} className="space-y-3">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="token" value={token} />

        <div className="space-y-1.5">
          <label
            htmlFor="claim-email"
            className="block text-sm font-medium text-fg"
          >
            Email
          </label>
          <input
            id="claim-email"
            type="email"
            value={email}
            readOnly
            disabled
            className="w-full rounded-md border border-line bg-surface-2 h-10 px-3 text-sm text-fg-muted"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="claim-password"
            className="block text-sm font-medium text-fg"
          >
            New password
          </label>
          <input
            id="claim-password"
            type="password"
            name="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className="w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          />
        </div>
        <div className="space-y-1.5">
          <label
            htmlFor="claim-confirm"
            className="block text-sm font-medium text-fg"
          >
            Confirm password
          </label>
          <input
            id="claim-confirm"
            type="password"
            name="confirm"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="Re-enter your password"
            className="w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
          />
        </div>
        <button
          type="submit"
          className="w-full rounded-md bg-yellow text-gold-ink h-10 px-4 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
        >
          Set password
        </button>
      </form>
    </AuthShell>
  );
}
