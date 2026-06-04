import Image from "next/image";
import Link from "next/link";
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
      <header className="sticky top-0 z-40 h-16 border-b border-line bg-page/80 backdrop-blur-md">
        <div className="mx-auto flex h-full items-center justify-between gap-4 px-6 lg:px-8 2xl:px-12">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href={role === "admin" ? "/admin" : "/coach"}
              className="flex shrink-0 items-center gap-2.5 group"
            >
              <Image
                src="/pfa-logo.png"
                alt="PFA"
                width={28}
                height={28}
                priority
                className="h-7 w-7 object-contain"
              />
              <span className="font-semibold tracking-tight text-[17px]">
                <span className="text-fg">PFA</span>{" "}
                <span className="text-gold-strong">Engine</span>
              </span>
              <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-fg-subtle border-l border-line pl-2">
                {role}
              </span>
            </Link>

            <div className="border-l border-line pl-3 min-w-0">
              <TabNav role={role} />
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-4">
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
                className="rounded-lg border border-line-strong bg-surface text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] h-9 px-3.5 text-[13px] font-medium"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full px-6 lg:px-8 2xl:px-12 py-10">
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
