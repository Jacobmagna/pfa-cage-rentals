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
  eyebrow = "PFA Travel",
  children,
}: Readonly<{
  heading: string;
  subheading?: string;
  eyebrow?: string;
  children: React.ReactNode;
}>) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center py-8">
      {/* Flat card with a crisp 2px gold top accent + hairline sides — the
          signature brand stroke echoed from the masthead. */}
      <div className="w-full max-w-sm rounded-md border border-line border-t-2 border-t-yellow bg-surface p-7">
        {/* Crest monogram — black+gold, echoes the masthead for brand cohesion. */}
        <span className="flex size-11 items-center justify-center rounded-md bg-[#0a0a0a]">
          <span className="text-gold text-[11px] font-bold tracking-[0.15em]">
            PFA
          </span>
        </span>

        <p className="mt-6 text-[10px] uppercase tracking-[0.2em] text-fg-subtle">
          {eyebrow}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight text-fg">
          {heading}
        </h1>
        {subheading ? (
          <p className="mt-2 text-sm text-fg-muted">{subheading}</p>
        ) : null}

        <div className="mt-7">{children}</div>
      </div>
    </section>
  );
}
