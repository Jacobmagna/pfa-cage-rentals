import type { Metadata } from "next";

// Travel slice layout. Rendered as the rewrite target for
// travel.pfaengine.com (src/proxy.ts rewrites `/x` → `/travel/x` when
// TRAVEL_ENABLED=true). The ROOT layout (src/app/layout.tsx) already owns
// <html>/<body> + fonts + globals, so this layout must NOT render those —
// it only contributes travel's own chrome (a wrapper + header) around the
// route-group children.
//
// This is a deliberately minimal PLACEHOLDER shell: a text wordmark header
// and a centered main container, styled with the existing neutral design
// tokens (bg-page, text-fg, border-line…). The real travel brand system,
// logo, and navigation are later scoped tasks — nothing invented here.

export const metadata: Metadata = {
  title: "PFA Travel",
};

export default function TravelLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen flex-1 flex-col bg-page text-fg">
      {/* Brand masthead: confident near-black bar + a signature gold rule. */}
      <header>
        <div className="bg-[#0a0a0a]">
          <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
            {/* Wordmark lockup: crest monogram + PFA TRAVEL. */}
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-md ring-1 ring-white/15">
                <span className="text-gold text-[10px] font-bold tracking-widest">
                  PFA
                </span>
              </span>
              <span className="text-base font-bold tracking-tight">
                <span className="text-white">PFA</span>{" "}
                <span className="text-gold">TRAVEL</span>
              </span>
            </div>

            {/* Credential label (desktop only). */}
            <span className="hidden text-[10px] uppercase tracking-[0.2em] text-white/50 sm:inline">
              Family &amp; Operator Portal
            </span>
          </div>
        </div>
        {/* Signature 2px gold brand stroke. */}
        <div className="h-0.5 bg-yellow" />
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10">
        {children}
      </main>
    </div>
  );
}
