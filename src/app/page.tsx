import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { GoogleSignInButton } from "./_components/google-signin-button";

export default async function Home() {
  const session = await auth();
  if (session?.user) {
    redirect(session.user.role === "admin" ? "/admin" : "/coach");
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="rounded-lg border border-line bg-surface px-8 py-10 shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset]">
          <div className="space-y-2 text-center mb-8">
            <h1 className="text-2xl font-bold tracking-tight text-gold">
              PFA Cage Rentals
            </h1>
            <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
              Cage · Bullpen · Weight Room
            </p>
          </div>

          <div className="space-y-4">
            <GoogleSignInButton />

            <div className="flex items-center gap-3 text-xs text-fg-subtle">
              <div className="h-px flex-1 bg-line" />
              <span className="uppercase tracking-wider">or</span>
              <div className="h-px flex-1 bg-line" />
            </div>

            <form
              action={async (formData: FormData) => {
                "use server";
                const email = formData.get("email")?.toString().trim();
                if (!email) return;
                await signIn("resend", { email, redirectTo: "/" });
              }}
              className="space-y-3"
            >
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
