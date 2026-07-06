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
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center px-6">
          <span className="text-base font-bold tracking-tight text-fg">
            PFA Travel
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6 py-10">
        {children}
      </main>
    </div>
  );
}
