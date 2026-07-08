// Shared auth-card shell for the travel parent-auth screens (signin, claim,
// forgot, reset). A small server component that renders the LOCKED "sharper /
// more official" travel skin uniformly: a centered, flat (no shadow), crisp
// `rounded-md` card on the warm surface with a "PFA TRAVEL" eyebrow, a bold
// heading, and an optional subheading — then the caller's form/banners as
// children. Reuse everywhere so the skin never drifts between screens.
//
// Colors come ONLY from the existing facility tokens (bg-surface, border-line,
// text-fg / text-fg-muted / text-fg-subtle) — nothing invented.

export function AuthShell({
  heading,
  subheading,
  children,
}: Readonly<{
  heading: string;
  subheading?: string;
  children: React.ReactNode;
}>) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center py-8">
      <div className="w-full max-w-sm rounded-md border border-line bg-surface p-6">
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          PFA Travel
        </p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg">
          {heading}
        </h1>
        {subheading ? (
          <p className="mt-2 text-sm text-fg-muted">{subheading}</p>
        ) : null}

        <div className="mt-6">{children}</div>
      </div>
    </section>
  );
}
