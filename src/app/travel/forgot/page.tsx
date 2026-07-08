import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "../_components/auth-shell";
import { requestTravelReset } from "./actions";

export const metadata: Metadata = {
  title: "Reset your password — PFA Travel",
};

// Travel password-reset request. A single email field → a no-enumeration
// confirmation (?sent=1) shown regardless of whether the email has an account.
// Renders in the sharper travel skin via AuthShell.

type SearchParams = Promise<{ sent?: string; error?: string }>;

const ERROR_COPY: Record<string, string> = {
  "email-limit":
    "Too many attempts for this email. Try again in an hour.",
  "ip-limit":
    "Too many attempts from your network. Try again in an hour.",
};

const ERROR_FALLBACK = "Something went wrong. Please try again in a moment.";

export default async function TravelForgot({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { sent, error } = await searchParams;
  const errorMessage = error ? ERROR_COPY[error] ?? ERROR_FALLBACK : null;

  return (
    <AuthShell
      heading="Reset your password"
      subheading="Enter your email and we'll send you a reset link."
    >
      {sent ? (
        <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-fg-muted">
          If that email has an account, we&apos;ve sent a reset link. Check your
          inbox.
        </p>
      ) : (
        <>
          {errorMessage ? (
            <p
              role="alert"
              className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger"
            >
              {errorMessage}
            </p>
          ) : null}

          <form action={requestTravelReset} className="space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="forgot-email"
                className="block text-[11px] uppercase tracking-wider font-semibold text-fg-muted"
              >
                Email
              </label>
              <input
                id="forgot-email"
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="you@example.com"
                className="w-full rounded-md border border-line bg-page h-10 px-3 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
              />
            </div>
            <button
              type="submit"
              className="w-full rounded-md bg-yellow text-gold-ink h-10 px-4 text-sm font-semibold transition-colors hover:bg-gold-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
            >
              Send reset link
            </button>
          </form>
        </>
      )}

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
