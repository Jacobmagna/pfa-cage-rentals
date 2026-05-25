import Link from "next/link";
import { auth, signOut } from "@/auth";

/**
 * App shell with top nav.
 * Used by /admin and /coach landing pages.
 */
export async function AppShell({
  children,
  role,
}: {
  children: React.ReactNode;
  role: "admin" | "coach";
}) {
  const session = await auth();
  const displayName =
    session?.user?.name?.split(" ")[0] ?? session?.user?.email ?? "User";

  return (
    <>
      <header className="sticky top-0 z-40 h-14 border-b border-line bg-surface/80 backdrop-blur-md">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-6 lg:px-8">
          <Link
            href={role === "admin" ? "/admin" : "/coach"}
            className="flex items-center gap-2 group"
          >
            <span className="text-base font-bold tracking-tight text-gold group-hover:text-gold-hover transition-colors">
              PFA Cage Rentals
            </span>
            <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-fg-subtle border-l border-line pl-2">
              {role}
            </span>
          </Link>

          <div className="flex items-center gap-4">
            <span className="hidden sm:inline text-xs text-fg-muted">
              {displayName}
            </span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="rounded-md border border-line bg-surface-2 text-fg-muted hover:text-fg hover:border-line-strong h-8 px-3 text-xs font-medium transition-colors"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-7xl px-6 lg:px-8 py-10">
        {children}
      </main>

      <footer className="mx-auto w-full max-w-7xl px-6 lg:px-8 pb-6 pt-4 border-t border-line/60 text-xs text-fg-subtle flex gap-4">
        <Link href="/privacy" className="hover:text-fg-muted transition-colors">
          Privacy
        </Link>
        <Link href="/terms" className="hover:text-fg-muted transition-colors">
          Terms
        </Link>
      </footer>
    </>
  );
}
