import type { Session } from "next-auth";
import Image from "next/image";
import Link from "next/link";
import { redirect, unstable_rethrow } from "next/navigation";
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
  // Auth.js: our signIn callback returned false because the email
  // isn't authorized (invite-only). Friendly, and deliberately does
  // NOT reveal whether the email exists.
  AccessDenied:
    "This email isn't authorized for PFA Engine yet. Ask PFA to add you, then try again.",
};

const ERROR_FALLBACK =
  "Something went wrong signing in. Try again, or use the other method above.";

export default async function Home({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  // The landing/sign-in page is the critical entry point, so a transient
  // session-lookup failure (e.g. a Neon DB blip) must not 500 the page.
  // Wrap ONLY the auth() call: on error we log and treat the user as
  // signed-out so the normal sign-in form still renders. The redirect()
  // below stays OUTSIDE the try/catch — it works by throwing NEXT_REDIRECT
  // internally, which the catch must never swallow.
  let session: Session | null = null;
  try {
    session = await auth();
  } catch (err) {
    unstable_rethrow(err);
    console.error("[signin] auth() lookup failed; rendering signed-out view", err);
  }
  if (session?.user) {
    redirect(session.user.role === "admin" ? "/admin" : "/coach");
  }

  const { error } = await searchParams;
  const errorMessage = error
    ? (ERROR_COPY[error] ?? ERROR_FALLBACK)
    : undefined;

  return (
    <main className="relative flex min-h-screen flex-1 flex-col items-center justify-center bg-black px-6 py-16">
      {/* Ambient yellow radial glow behind the card so the centered layout
          anchors visually instead of floating in pure black. Decorative,
          pointer-events: none so it doesn't intercept anything. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <div className="h-[640px] w-[640px] max-w-full rounded-full bg-yellow/[0.05] blur-3xl" />
      </div>

      <div className="relative w-full max-w-sm">
        {/* Brand lockup. Vertical hierarchy:
             1. The combined "PFA ENGINE" logo lockup (carries the wordmark)
             2. Hairline-rule-with-diamond divider, signalling that
                anything beneath is descriptive copy and not part of
                the name
             3. The positioning sentence, wrapped tight so it reads
                as a placard rather than a marketing tagline */}
        <div className="mb-10 text-center">
          <Image
            src="/pfa-engine-logo.png"
            alt="PFA Engine"
            width={1672}
            height={941}
            priority
            className="mx-auto w-72 h-auto"
          />
          <div
            aria-hidden
            className="mt-6 mx-auto flex items-center justify-center gap-2.5"
          >
            <span className="h-px w-10 bg-yellow/30" />
            <DiamondMark className="h-2 w-2 text-yellow/60" filled />
            <span className="h-px w-10 bg-yellow/30" />
          </div>
          <p className="mt-4 mx-auto max-w-[24ch] text-sm leading-relaxed text-white/60">
            A private reservation system, built by PFA for the coaches who
            train with us.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <GoogleSignInButton />

          <div className="my-5 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/15" />
            <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">
              or with email
            </span>
            <div className="h-px flex-1 bg-white/15" />
          </div>

          <form action={requestMagicLink} className="space-y-3">
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              aria-label="Email address"
              placeholder="you@example.com"
              className="w-full rounded-lg border border-white/15 bg-white/5 px-3 h-10 text-sm text-white placeholder:text-white/40 transition-colors focus:outline-none focus:border-white/30 focus:ring-2 focus:ring-yellow/40"
            />
            {errorMessage ? (
              <p role="alert" className="text-xs text-danger leading-relaxed">
                {errorMessage}
              </p>
            ) : null}
            <button
              type="submit"
              className="w-full rounded-lg border border-white/20 bg-white/5 text-white/85 h-10 px-4 text-sm font-medium transition hover:text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow/40"
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
          <p className="flex items-center justify-center gap-3 text-[11px] text-white/40">
            <Link
              href="https://pfasports.com"
              target="_blank"
              rel="noopener noreferrer"
              className="transition-colors hover:text-white/75"
            >
              PFA Sports
            </Link>
            <span aria-hidden className="text-white/25">·</span>
            <Link
              href="/privacy"
              className="transition-colors hover:text-white/75"
            >
              Privacy
            </Link>
            <span aria-hidden className="text-white/25">·</span>
            <Link
              href="/terms"
              className="transition-colors hover:text-white/75"
            >
              Terms
            </Link>
          </p>
          <Link
            href="/coach-guide"
            className="text-[11px] text-white/40 transition-colors hover:text-white/75"
          >
            New here? Read the Coach Guide
          </Link>
          <p className="text-[10px] uppercase tracking-[0.14em] text-white/30">
            Built by Magna Software LLC
          </p>
        </div>
      </div>
    </main>
  );
}
