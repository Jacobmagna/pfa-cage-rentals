# PFA Cage Rentals — Design Spec

Locked 2026-05-23. Light rebrand (FEAT-04) 2026-05-31. Source of truth for visual decisions. Re-read before any non-trivial UI work.

## North star

**Premium light dashboard: white base, black text and primary controls, warm PFA gold as the signature accent.** Production-grade polish (think Vercel / Linear / Railway), not Wix-template generic. Internal tool density beats marketing flourish — every pixel earns its place. Same premium feel as the original dark system, just lighter.

## Brand alignment

Parent brand: **PFA Sports — The Hub** (`pfasports.com`).
- White / near-white surfaces dominate; near-black (`#0a0a0a`) text and primary controls.
- Warm gold (~`#e9b13c`) is the singular brand accent — used for highlights, CTAs, focus, and active states, NOT as a dominant fill.
- Bold geometric all-caps for headers.
- Vibe: athletic, masculine, premium, slightly aggressive.

We don't replicate the PFA Sports shield logo or the parent site's display font for the wordmark. We channel the same energy through palette, weight, and typographic rhythm.

---

## Color tokens

Declared as CSS variables in `src/app/globals.css`. Use these — don't inline hex values in components.

Token names are stable across the rebrand — only values flipped dark→light. Tailwind utility names: `bg-page/surface/surface-2`, `border-line/line-strong`, `text-fg/fg-muted/fg-subtle/fg-disabled`, `bg-gold/text-gold/border-gold/text-gold-ink/text-gold-strong`, `text-success/warning/danger`.

### Surfaces
- `--color-page`         `#ffffff`   page background (white)
- `--color-surface`      `#f7f7f7`   cards, panels, raised UI (near-white elevation)
- `--color-surface-2`    `#ededed`   nested or hovered surfaces
- `--color-line`         `#e5e5e5`   1px dividers and card outlines
- `--color-line-strong`  `#d4d4d4`   focused inputs, table headers

### Ink (text + icons)
- `--color-fg`           `#0a0a0a`   primary text (near-black)
- `--color-fg-muted`     `#595959`   secondary text, labels
- `--color-fg-subtle`    `#646464`   placeholder, captions
- `--color-fg-disabled`  `#a3a3a3`   disabled controls (WCAG-exempt)

WCAG AA 4.5:1 verified on all three surfaces (page / surface / surface-2):
| Ink | page | surface | surface-2 |
|---|---|---|---|
| `fg` | 19.80 | 18.48 | 16.91 |
| `fg-muted` | 7.00 | 6.60 | 5.93 |
| `fg-subtle` | 5.92 | 5.52 | 5.05 |

### Brand
- `--color-gold`         `#e9b13c`   primary accent — CTA fills, focus rings, active states, logo, large/bold accents
- `--color-gold-hover`   `#f0bf52`   hover state on gold elements
- `--color-gold-ink`     `#0a0a0a`   text on gold backgrounds (10.20:1 on gold — AA/AAA)
- `--color-gold-strong`  `#8a6206`   AA-legible gold for gold-COLORED *text* (5.18 page / 4.84 surface). Use only where gold text is required — prefer gold-ink-on-gold fills.

Note: plain `--color-gold` is ~1.94:1 on white — it is a fill/accent color, never small body text. Use `text-gold-strong` for gold-tinted text.

### Status (darkened to read on white; AA 4.5:1 on all surfaces)
- `--color-success`      `#166534`   paid invoices, confirmed sessions (7.13 / 6.66 / 6.09)
- `--color-warning`      `#9a5208`   pending, due-soon (5.86 / 5.47 / 5.00)
- `--color-danger`       `#b01818`   delete confirmations, overdue invoices, use sparingly (7.02 / 6.56 / 6.00)

Status pills (`bg-success/10 text-success` etc.) stay legible: the `/10` tint over white is far lighter than surface-2, so the text ratio in pills exceeds the surface-2 numbers above.

### Anti-rules
- Don't hardcode hex in components — use the semantic tokens (the `next/og` image routes `icon.tsx` / `opengraph-image.tsx` are the only exception, since `next/og` can't read CSS vars).
- Surfaces are always white or a near-white elevation grey — don't invent surface colors outside the `surface` / `surface-2` ladder.
- Don't introduce new accent colors. Gold is the only brand color. Status colors are status, not decoration.
- Gold is an accent, not a dominant fill — reserve large gold areas for CTAs and signature moments.

---

## Typography

### Family
- **Geist Sans** for all UI text (already loaded via `next/font/google` in `src/app/layout.tsx`).
- **Geist Mono** for tabular data — session counts, dollar amounts, times, IDs. Anywhere digits should line up.
- No display font. The PFA Sports wordmark is custom — we gesture at its vibe with weight, not letterforms.

### Scale (Tailwind tokens)
| Use | Token | Weight | Tracking |
|---|---|---|---|
| Page H1 | `text-3xl` (1.875rem) | `font-bold` (700) | `tracking-tight` |
| Section H2 | `text-xl` (1.25rem) | `font-semibold` (600) | `tracking-tight` |
| Sub-section H3 | `text-base` (1rem) | `font-semibold` | normal |
| Body | `text-sm` (0.875rem) | `font-normal` | `leading-relaxed` |
| Caption / muted | `text-xs` (0.75rem) | `font-normal` | normal |
| **Eyebrow label** | `text-xs` | `font-medium` | `uppercase tracking-[0.14em]` |
| Mono data | `font-mono text-sm` | `font-medium` | `tabular-nums` |

### Headers
- Heavy weights (`font-bold` 700+) for H1/H2.
- All-caps eyebrows for section labels (echoes PFA's "OUR TWO FLAGSHIP INDOOR TRAINING CENTERS").
- Don't all-caps body paragraphs or long headers — only short eyebrows.

---

## Spacing & layout

### Grid
- **8px base unit** (Tailwind's default `space-2 = 8px`).
- Section vertical rhythm: `space-y-6` between blocks, `space-y-8` between major sections, `space-y-12` between full page areas.

### Widths
- Forms: `max-w-md` (28rem) for single-column, `max-w-2xl` for detailed multi-field.
- Tables / grids / reports: `max-w-7xl` (80rem).
- Dashboard pages: `max-w-7xl` with `px-6 lg:px-8`.

### Corners
- Cards: `rounded-lg` (0.5rem).
- Inputs / buttons: `rounded-md` (0.375rem).
- Pills / chips: `rounded-full`.
- Never `rounded-xl`+ on functional UI (too consumer-y).

### Borders & shadows
- 1px borders, never thicker.
- **No shadows** in app surfaces. Depth via background contrast, not blur. (Marketing/auth shell can use a single subtle drop shadow for the centered sign-in card if needed.)

---

## Components

### Buttons

```
Primary:    bg-gold text-gold-ink hover:bg-gold-hover focus-visible:ring-2 ring-gold/40
Secondary:  bg-surface-2 text-text border border-border hover:bg-surface
Ghost:      text-text-muted hover:text-text hover:bg-surface
Destructive: bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20
```

- Height: `h-9` (36px) default, `h-10` (40px) for primary on standalone forms (sign-in).
- Padding: `px-4`.
- Font: `text-sm font-medium`.
- Always include disabled state: `disabled:opacity-50 disabled:cursor-not-allowed`.

### Inputs

```
bg-bg border border-border text-text
placeholder:text-text-subtle
focus:outline-none focus:border-border-strong focus:ring-2 focus:ring-gold/40
rounded-md px-3 py-2 text-sm
```

- Labels above the input, `text-xs uppercase tracking-wider text-text-muted` (eyebrow style).
- Validation errors: `text-xs text-danger mt-1`.

### Cards

```
bg-surface border border-border rounded-lg p-6
```

- Optional eyebrow at the top in `--text-muted`, then content.
- Hover affordance only if the whole card is interactive: `hover:border-border-strong transition-colors`.

### Tables

- Header row: `bg-surface-2 text-text-muted text-xs uppercase tracking-wider`.
- Body rows: 1px bottom border `border-border`, hover `bg-surface-2/50`.
- Numeric columns: `font-mono tabular-nums text-right`.
- No vertical borders. No zebra unless rows exceed ~20.

### Top nav (app shell)

- Height: `h-14` (56px).
- Background: `bg-surface border-b border-border`.
- Left: gold wordmark `PFA Cage Rentals` in `font-bold tracking-tight`.
- Right: user menu (avatar circle + email dropdown with Sign out).
- Sticky: `sticky top-0 z-40 backdrop-blur-md bg-surface/80` if scroll-aware.

### Status pills

```
Paid:     bg-success/10 text-success border border-success/30
Pending:  bg-warning/10 text-warning border border-warning/30
Overdue:  bg-danger/10 text-danger border border-danger/30
```

`text-xs font-medium uppercase tracking-wider px-2 py-0.5 rounded-full`

---

## Surfaces

### Sign-in page (the only "marketing-leaning" page)

- Full-page white background (`bg-page`).
- Centered card (`max-w-sm`) on `bg-surface` with `border border-line`.
- Gold wordmark above the form (slightly larger than nav: `text-2xl font-bold`).
- Tagline below in muted: "Cage, bullpen, and weight-room rental tracking."
- Two clear sign-in options: gold primary button "Continue with Google", muted divider "or", email input + gold-bordered "Email me a sign-in link" button.
- Tiny footnote at the bottom linking to pfasports.com: `text-xs text-text-subtle`.

### Admin / Coach dashboards

- Top nav (above).
- `bg-page` page background (white).
- Pages render their own cards/tables within `max-w-7xl mx-auto px-6 lg:px-8 py-8` container.
- Page H1 at top, optional muted subtitle.
- No sidebar in Phase 1 — top nav is the only chrome. Sidebar lands in Phase 5 (Schedule grid view) if needed.

---

## Motion

- Use transitions sparingly: `transition-colors duration-150` on hover/focus.
- No entrance animations on page load. No spring physics. No parallax. Nothing decorative.
- Skeleton loaders for async data > 200ms expected.

---

## Mobile

- Coach surfaces (session logging) **must work on phone**. They'll log right after a lesson.
- Admin surfaces are **desktop-first** (schedule grid needs the real estate).
- Top nav collapses to hamburger below `md` (768px).
- Touch targets: minimum `h-10` (40px) on mobile.

---

## Iconography

- **Lucide React** (`npm i lucide-react`) — clean line icons, ~24px default.
- Stroke 2px.
- Inherit `currentColor` so they auto-respect text color tokens.
- No emoji in UI (use Lucide).

Common iconography:
- `Calendar` — schedule
- `Users` — coaches
- `FileText` — reports
- `Settings` — admin settings
- `LogOut` — sign out
- `Plus` — new entry
- `Trash2` — delete (always with `--danger` color)

---

## Anti-patterns

- ❌ Gradients (background, button, text)
- ❌ Glassmorphism / heavy blur
- ❌ Photography in app shell (sign-in is the only exception, and even there we'd use solid color)
- ❌ Illustrations or decorative SVG art
- ❌ Multi-color status systems beyond the four (`success`, `warning`, `danger`, default muted)
- ❌ Dark mode / theme toggle — we are light-by-default (FEAT-04). No `prefers-color-scheme` switch.
- ❌ Custom scrollbars
- ❌ Sound effects, page-load animations, hover sparkles
- ❌ Replicating the PFA Sports shield logo or custom wordmark letterforms
- ❌ Using `--danger` red for anything except destructive actions and overdue status

---

## Future open questions (defer to later phases)

- **Schedule grid** (Phase 5): will need a custom dense table. Spec the cell hover, drag selection, time-axis treatment, then.
- **Reports / Excel preview**: when reports get a web preview surface (Phase 4+), the table spec above scales. Revisit dense-data treatment then.
- **Coach mobile** (Phase 3): may need a bottom tab bar pattern. Decide when we build it.
- **Notifications** (open from BRAINSTORM): if we add them, slide-in toast top-right, `--surface-2` with gold accent for success, danger for error.
