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
    <main className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-line bg-surface px-8 py-10 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
          <div className="text-center mb-8">
            <Image
              src="/pfa-logo.png"
              alt="PFA Sports"
              width={813}
              height={813}
              priority
              className="mx-auto h-20 w-auto"
            />
            <h1 className="mt-3 text-sm uppercase tracking-[0.28em] text-gold font-semibold">
              Cage Rentals
            </h1>
          </div>

          <div className="space-y-4">
            <GoogleSignInButton />

            <div className="flex items-center gap-3 text-xs text-fg-subtle">
              <div className="h-px flex-1 bg-line" />
              <span className="uppercase tracking-wider">or</span>
              <div className="h-px flex-1 bg-line" />
            </div>

            <form action={requestMagicLink} className="space-y-3">
              <label className="block">
                <span className="block text-xs uppercase tracking-wider text-fg-muted mb-1.5">
                  Email
                </span>
                <input
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  className="w-full rounded-md bg-page border border-line text-fg placeholder:text-fg-subtle px-3 py-2 text-sm focus:outline-none focus:border-line-strong focus:ring-2 focus:ring-gold/40"
                />
              </label>
              {errorMessage ? (
                <p
                  role="alert"
                  className="text-xs text-red-400 leading-relaxed"
                >
                  {errorMessage}
                </p>
              ) : null}
              <button
                type="submit"
                className="w-full rounded-md border border-line bg-surface-2 text-fg h-10 px-4 text-sm font-medium hover:bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
              >
                Email me a sign-in link
              </button>
            </form>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-fg-subtle">
          Part of{" "}
          <Link
            href="https://pfasports.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-fg-muted hover:text-gold transition-colors"
          >
            PFA Sports
          </Link>
        </p>
      </div>
    </main>
  );
}
