import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { DiamondMark } from "./_components/diamond-mark";
import { GoogleSignInButton } from "./_components/google-signin-button";
import { requestMagicLink } from "./actions";

type SearchParams = Promise<{ error?: string }>;

// Explicit copy for the codes we redirect to ourselves
// (requestMagicLink in src/app/actions.ts) plus a couple of Auth.js
// error codes that have a clear user action. Anything else falls back
// to a generic message so the user never sees an empty-banner
// "?error=Foo" state.
const ERROR_COPY: Record<string, string> = {
  "missing-email": "Please enter your email address.",
  "email-limit":
    "Too many sign-in attempts for this email. Try again in an hour.",
  "ip-limit":
    "Too many sign-in attempts from your network. Try again in an hour.",
  // Auth.js: the email already exists under a different provider link
  // path. Because allowDangerousEmailAccountLinking is enabled on the
  // Google provider, this code is rare — but Resend can still surface
  // it on edge cases.
  OAuthAccountNotLinked:
    "This email is already linked to another sign-in method. Try the other option above.",
  // Auth.js: verification token expired or already consumed.
  Verification:
    "That sign-in link expired or was already used. Request a new one.",
};

const ERROR_FALLBACK =
  "Something went wrong signing in. Try again, or use the other method above.";

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
  const errorMessage = error
    ? (ERROR_COPY[error] ?? ERROR_FALLBACK)
    : undefined;

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
        {/* Brand lockup. Three-tier vertical hierarchy:
             1. PFA Sports logo (parent brand)
             2. "Cage Rentals" — the product wordmark, promoted from
                eyebrow label to a proper Geist-bold gold wordmark
             3. Hairline-rule-with-diamond divider, signalling that
                anything beneath is descriptive copy and not part of
                the name
             4. The positioning sentence, wrapped tight so it reads
                as a placard rather than a marketing tagline */}
        <div className="mb-10 text-center">
          <Image
            src="/pfa-logo.png"
            alt="PFA Sports"
            width={813}
            height={813}
            priority
            className="mx-auto h-24 w-auto"
          />
          <h1 className="mt-7 text-3xl font-bold tracking-tight text-gold">
            Cage Rentals
          </h1>
          <div
            aria-hidden
            className="mt-4 mx-auto flex items-center justify-center gap-2.5"
          >
            <span className="h-px w-10 bg-gold/30" />
            <DiamondMark className="h-2 w-2 text-gold/60" filled />
            <span className="h-px w-10 bg-gold/30" />
          </div>
          <p className="mt-4 mx-auto max-w-[24ch] text-sm leading-relaxed text-fg-muted">
            A private reservation system, built by PFA for the coaches who
            train with us.
          </p>
        </div>

        <div className="rounded-lg border border-line bg-surface/80 p-6 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_20px_60px_-20px_rgba(0,0,0,0.5)] backdrop-blur-sm">
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

        {/* Footer, two tiers — existing nav links centered on top, Magna
            attribution beneath at lower visual weight. The credit is an
            unlinked legal signature (Apple-California cadence) rather
            than a marketing line; when magnasoftware.com exists we
            promote it to a link. */}
        <div className="mt-8 flex flex-col items-center gap-3">
          <p className="flex items-center justify-center gap-3 text-[11px] text-fg-subtle">
            <Link
              href="https://pfasports.com"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-fg-muted"
            >
              PFA Sports
            </Link>
            <span aria-hidden className="text-fg-disabled">·</span>
            <Link
              href="/privacy"
              className="transition-colors hover:text-fg-muted"
            >
              Privacy
            </Link>
            <span aria-hidden className="text-fg-disabled">·</span>
            <Link
              href="/terms"
              className="transition-colors hover:text-fg-muted"
            >
              Terms
            </Link>
          </p>
          <p className="text-[10px] uppercase tracking-[0.14em] text-fg-disabled">
            Built by Magna Software LLC
          </p>
        </div>
      </div>
    </main>
  );
}
