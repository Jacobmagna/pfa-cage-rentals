import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { GoogleSignInButton } from "./_components/google-signin-button";
import { requestMagicLink } from "./actions";

type SearchParams = Promise<{ error?: string }>;

const ERROR_COPY: Record<string, string> = {
  "missing-email": "Please enter your email address.",
  "email-limit":
    "Too many sign-in attempts for this email. Try again in an hour.",
  "ip-limit":
    "Too many sign-in attempts from your network. Try again in an hour.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await auth();
  if (session?.user) {
    redirect(session.user.role === "admin" ? "/admin" : "/coach");
  }

  const { error } = await searchParams;
  const errorMessage = error ? ERROR_COPY[error] : undefined;

  return (
    <main className="relative flex flex-1 flex-col items-center justify-center px-6 py-16">
      {/* Ambient gold radial glow behind the card so the centered layout
          anchors visually instead of floating in pure black. Decorative,
          pointer-events: none so it doesn't intercept anything. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="h-[640px] w-[640px] max-w-full rounded-full bg-gold/[0.06] blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        <div className="mb-10 text-center">
          <Image
            src="/pfa-logo.png"
            alt="PFA Sports"
            width={813}
            height={813}
            priority
            className="mx-auto h-24 w-auto"
          />
          <h1 className="mt-5 text-base font-semibold tracking-[0.32em] text-gold uppercase">
            Cage Rentals
          </h1>
          <p className="mt-3 text-sm text-fg-muted">
            Schedule and bill your time at the PFA facility.
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface/80 p-6 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_20px_60px_-20px_rgba(0,0,0,0.5)] backdrop-blur-sm">
          <GoogleSignInButton />

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-line" />
            <span className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
              or with email
            </span>
            <div className="h-px flex-1 bg-line" />
          </div>

          <form action={requestMagicLink} className="space-y-3">
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              aria-label="Email address"
              placeholder="you@example.com"
              className="w-full rounded-md border border-line bg-page px-3 h-10 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
            />
            {errorMessage ? (
              <p role="alert" className="text-xs text-danger leading-relaxed">
                {errorMessage}
              </p>
            ) : null}
            <button
              type="submit"
              className="w-full rounded-md border border-line bg-surface-2 text-fg h-10 px-4 text-sm font-medium transition-colors hover:bg-surface hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
            >
              Send me a sign-in link
            </button>
          </form>
        </div>

        <p className="mt-8 flex items-center justify-center gap-3 text-[11px] text-fg-subtle">
          <Link
            href="https://pfasports.com"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-fg-muted"
          >
            PFA Sports
          </Link>
          <span aria-hidden className="text-fg-disabled">·</span>
          <Link href="/privacy" className="transition-colors hover:text-fg-muted">
            Privacy
          </Link>
          <span aria-hidden className="text-fg-disabled">·</span>
          <Link href="/terms" className="transition-colors hover:text-fg-muted">
            Terms
          </Link>
        </p>
      </div>
    </main>
  );
}
