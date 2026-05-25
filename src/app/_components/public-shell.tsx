import Link from "next/link";
import { auth } from "@/auth";

// Shell for public legal pages (/privacy, /terms). Unlike AppShell,
// requires no role and doesn't render a sign-out button — these pages
// must load for signed-out visitors (the Google OAuth consent screen
// links here, for example). Top-right shows a "Back to dashboard" link
// for signed-in users or "Sign in" for guests.

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
          <Link href="/" className="group">
            <span className="text-base font-bold tracking-tight text-gold group-hover:text-gold-hover transition-colors">
              PFA Cage Rentals
            </span>
          </Link>
          <Link
            href={ctaHref}
            className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-8 inline-flex items-center px-3 text-xs font-medium transition-colors"
          >
            {ctaLabel}
          </Link>
        </div>
      </header>

      <div className="flex-1 mx-auto w-full max-w-3xl px-6 py-12">
        {children}
        <div className="mt-12 border-t border-line pt-6 text-xs text-fg-subtle flex gap-6">
          <Link href="/privacy" className="hover:text-fg-muted transition-colors">
            Privacy Policy
          </Link>
          <Link href="/terms" className="hover:text-fg-muted transition-colors">
            Terms of Service
          </Link>
        </div>
      </div>
    </>
  );
}
