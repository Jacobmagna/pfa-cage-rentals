import Link from "next/link";
import { auth } from "@/auth";
import { DiamondMark } from "./diamond-mark";

// Shell for public legal pages (/privacy, /terms). Unlike AppShell,
// requires no role and doesn't render a sign-out button — these pages
// must load for signed-out visitors (the Google OAuth consent screen
// links here, for example). Top-right shows a "Back to dashboard" link
// for signed-in users or "Sign in" for guests.
//
// Matches AppShell's brand-mark + footer treatment so the same lockup
// and signature appear regardless of whether the visitor is signed in.

export async function PublicShell({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const ctaHref = session?.user
    ? session.user.role === "admin"
      ? "/admin"
      : "/coach"
    : "/";
  const ctaLabel = session?.user ? "Back to dashboard" : "Sign in";

  return (
    <>
      <header className="sticky top-0 z-40 h-14 border-b border-line bg-surface/80 backdrop-blur-md">
        <div className="mx-auto flex h-full max-w-3xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2.5 group">
            <DiamondMark
              className="h-2.5 w-2.5 text-gold/70 transition-colors group-hover:text-gold"
              filled
            />
            <span className="text-base font-semibold tracking-tight text-fg transition-colors">
              PFA <span className="text-gold-strong group-hover:text-gold-hover transition-colors">Engine</span>
            </span>
          </Link>
          <Link
            href={ctaHref}
            className="rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] h-8 inline-flex items-center px-3 text-xs font-medium transition"
          >
            {ctaLabel}
          </Link>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-3xl px-6 py-12">
        {children}
        <div className="mt-12 border-t border-line pt-6 text-xs text-fg-subtle">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <div className="flex gap-6">
              <Link
                href="/privacy"
                className="hover:text-fg-muted transition-colors"
              >
                Privacy Policy
              </Link>
              <Link
                href="/terms"
                className="hover:text-fg-muted transition-colors"
              >
                Terms of Service
              </Link>
            </div>
            <p className="text-[10px] uppercase tracking-[0.14em] text-fg-disabled">
              Built by Magna Software LLC
            </p>
          </div>
        </div>
      </main>
    </>
  );
}
