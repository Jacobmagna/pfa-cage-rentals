"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Master sub-nav — mirrors rentals-subnav.tsx exactly (markup, classes, gold
// underline, aria-current, focus ring). Renders at the top of the Master
// schedule surfaces, which reuse the admin schedule grids against the same
// live tables (two-way sync).
//
// Two sub-tabs: Cage Rental (main) and Work.
//
// Cage Rental is active ONLY on the exact /master/schedule path. Work is
// active when the pathname starts with /master/work-schedule. The two rules
// are disjoint, so they never both light up.

type SubTab = {
  href: string;
  label: string;
  isActive: (pathname: string) => boolean;
};

const SUB_TABS: SubTab[] = [
  {
    href: "/master/schedule",
    label: "Cage Rental",
    isActive: (p) => p === "/master/schedule",
  },
  {
    href: "/master/work-schedule",
    label: "Work",
    isActive: (p) => p.startsWith("/master/work-schedule"),
  },
];

export function MasterSubnav() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Master sections"
      className="border-b border-line bg-surface"
    >
      <ul className="flex gap-1 overflow-x-auto whitespace-nowrap -mb-px">
        {SUB_TABS.map((tab) => {
          const isActive = tab.isActive(pathname);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-flex items-center px-3 sm:px-4 py-3 text-sm border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded-sm",
                  isActive
                    ? "border-gold text-fg font-semibold"
                    : "border-transparent text-fg-muted font-medium hover:text-fg",
                ].join(" ")}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
