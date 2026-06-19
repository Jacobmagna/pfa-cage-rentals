import Image from "next/image";
import Link from "next/link";
import { Settings } from "lucide-react";
import { auth, signOut } from "@/auth";
import { TabNav } from "./tab-nav";

/**
 * App shell with top nav.
 * Used by /admin and /coach landing pages.
 *
 * The PFA logo image IS the brand mark — the same mark used on the
 * landing page and as the favicon — threading brand continuity into
 * every signed-in surface without adding chrome. The "Built by
 * Magna Software LLC" credit in the footer is the legal signature,
 * not a marketing line; matches the landing page footer.
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
      <header className="sticky top-0 z-40 border-b border-white/10 bg-black backdrop-blur-md">
        <div className="mx-auto flex h-16 items-center justify-between gap-4 px-4 sm:px-6 lg:px-8 2xl:px-12">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href={role === "admin" ? "/admin" : "/coach"}
              className="flex shrink-0 items-center gap-2.5 group"
            >
              <Image
                src="/pfa-engine-logo.png"
                alt="PFA Engine"
                width={1672}
                height={941}
                priority
                className="h-10 w-auto object-contain"
              />
              <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-white/55 border-l border-white/20 pl-2">
                {role}
              </span>
            </Link>

            <div className="hidden md:block border-l border-line pl-3 min-w-0">
              <TabNav role={role} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-4">
            <span className="hidden sm:inline text-xs text-white/70">
              {displayName}
            </span>
            {role === "coach" && (
              <Link
                href="/coach/settings"
                aria-label="Settings"
                title="Settings"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/20 bg-white/5 text-white/80 hover:text-white hover:bg-white/10"
              >
                <Settings className="h-4 w-4" aria-hidden="true" />
              </Link>
            )}
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/" });
              }}
            >
              <button
                type="submit"
                className="rounded-lg border border-white/20 bg-white/5 text-white/80 hover:text-white hover:bg-white/10 h-9 px-3.5 text-[13px] font-medium"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>

        <div className="md:hidden border-t border-white/10 px-3 py-1.5">
          <TabNav role={role} />
        </div>
      </header>

      <main className="flex-1 mx-auto w-full px-4 sm:px-6 lg:px-8 2xl:px-12 py-8 sm:py-10">
        {children}
      </main>

      <footer className="mx-auto w-full px-6 lg:px-8 2xl:px-12 pb-6 pt-4 border-t border-line/60 text-xs text-fg-subtle">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex gap-4">
            <Link href="/privacy" className="hover:text-fg-muted transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-fg-muted transition-colors">
              Terms
            </Link>
          </div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-fg-disabled">
            Built by Magna Software LLC
          </p>
        </div>
      </footer>
    </>
  );
}
