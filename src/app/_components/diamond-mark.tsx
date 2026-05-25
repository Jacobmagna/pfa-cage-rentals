// Brand mark for PFA Cage Rentals — a rotated square (diamond) outline.
// Reads as a baseball diamond at a glance without being a literal
// home-plate icon, and as a tight typographic glyph at small sizes.
// One shape, no path tricks, scales cleanly from 10px (nav glyph next
// to the wordmark) up to 192px (favicon, where it's rendered filled).
//
// Used as:
//   - Glyph before the "PFA Cage Rentals" wordmark in AppShell / PublicShell
//   - Hairline accent between the wordmark and tagline on the landing page
//   - The favicon (see src/app/icon.tsx — drawn there as a rotated div
//     since next/og's HTML subset is more reliable than inline <svg>)
//
// Inherits `currentColor`, so it picks up text-gold / text-fg-muted /
// whatever the parent sets. Defaults to outlined — pass `filled` only
// at small enough sizes that a stroked outline would disappear.

type Props = {
  className?: string;
  filled?: boolean;
};

export function DiamondMark({ className, filled = false }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={1.75}
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2.5 L21.5 12 L12 21.5 L2.5 12 Z" />
    </svg>
  );
}
