import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

// Shared dashboard nav tile: icon + title + one-line stat, links to a
// section. Plain server component (no client hooks) so it can render inside
// any admin server page. Extracted from the cage-rentals dashboard so the
// Billing & Records landing can reuse the exact same card.
export function NavCard({
  href,
  icon,
  title,
  stat,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  stat: string;
}) {
  return (
    <Link
      href={href}
      className="group relative flex items-start gap-3.5 rounded-xl border border-line bg-surface px-5 py-4 shadow-[var(--shadow-sm)] transition hover:-translate-y-0.5 hover:border-gold/40 hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:border-gold/40 focus-visible:ring-2 focus-visible:ring-gold/40"
    >
      <span className="grid h-10 w-10 flex-none place-items-center rounded-[10px] border border-line bg-surface-2 text-fg-muted transition group-hover:border-gold/40 group-hover:bg-gold/10 group-hover:text-gold-strong">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between">
          <span className="text-sm font-semibold text-fg">{title}</span>
          <ArrowUpRight className="h-3.5 w-3.5 -translate-x-1 text-gold-strong opacity-0 transition group-hover:translate-x-0 group-hover:opacity-100" />
        </span>
        <span className="mt-0.5 block text-sm text-fg-muted">{stat}</span>
      </span>
    </Link>
  );
}
