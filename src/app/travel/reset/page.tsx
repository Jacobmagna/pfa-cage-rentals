import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { resetTravelPassword } from "./actions";

export const metadata: Metadata = {
  title: "Choose a new password — PFA Travel",
};

// Travel password reset. A parent lands here from the emailed reset link
// (?email=&token=), chooses a new password, and is sent back to signin to log
// in fresh. Missing email/token → an invalid-link state (no form). Renders in
// the sharper travel skin via AuthShell.

type SearchParams = Promise<{
  email?: string;
  token?: string;
  error?: string;
}>;

const ERROR_COPY: Record<string, string> = {
  mismatch: "Those passwords don't match. Please re-enter them.",
  bad_token:
    "This reset link is invalid or expired. Request a new one.",
  weak_password: "Password must be at least 8 characters.",
};

const ERROR_FALLBACK =
  "Something went wrong resetting your password. Please try again.";

export default async function TravelReset({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { email, token, error } = await searchParams;

  // Missing link params → invalid-link state.
  if (!email || !token) {
    return (
      <AuthShell heading="Choose a new password">
        <p
          role="alert"
          className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          This reset link is invalid or incomplete. Request a new one.
        </p>
        <p className="mt-4 text-sm text-fg-muted">
          <Link
            href="/travel/forgot"
            className="font-medium text-fg underline underline-offset-2 hover:text-fg-muted"
          >
            Request a new reset link
          </Link>
        </p>
      </AuthShell>
    );
  }

  const errorMessage = error ? ERROR_COPY[error] ?? ERROR_FALLBACK : null;

  return (
    <AuthShell
      heading="Choose a new password"
      subheading="Enter a new password for your PFA Travel account."
    >
      {errorMessage ? (
        <p
          role="alert"
          className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      <form action={resetTravelPassword} className="space-y-3">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="token" value={token} />

        <div className="space-y-1.5">
          <label
            htmlFor="reset-password"
            className="block text-sm font-medium text-fg"
          >
            New password
          </label>
          <input
            id="reset-password"
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
            htmlFor="reset-confirm"
            className="block text-sm font-medium text-fg"
          >
            Confirm password
          </label>
          <input
            id="reset-confirm"
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
          Update password
        </button>
      </form>
    </AuthShell>
  );
}
