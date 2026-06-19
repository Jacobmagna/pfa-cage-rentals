"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Rentals sub-nav — mirrors hour-log-subnav.tsx exactly (markup, classes,
// gold underline, aria-current, focus ring). Replaces the old clickable-box
// dashboard at /admin/cage-rentals: the top "Rentals" tab now lands on the
// Schedule (the main view) which renders this menu bar at the top.
//
// Three sub-tabs: Schedule (main, first), Rentals, Removal requests.
//
// Schedule is active on /admin/schedule OR on /admin/cage-rentals (which
// now redirects to /admin/schedule, but keep it lit in case of an in-flight
// path). Rentals is active ONLY on the exact /admin/sessions path so it
// doesn't stay lit while its removal-requests child is open. Removal
// requests is active when the pathname starts with
// /admin/sessions/removal-requests. The Rentals-exact rule and the
// Removal-requests-prefix rule are disjoint, so they never both light up.

type SubTab = {
  href: string;
  label: string;
  isActive: (pathname: string) => boolean;
};

const SUB_TABS: SubTab[] = [
  {
    href: "/admin/schedule",
    label: "Schedule",
    isActive: (p) => p === "/admin/schedule" || p === "/admin/cage-rentals",
  },
  {
    href: "/admin/sessions",
    label: "Rentals",
    isActive: (p) => p === "/admin/sessions",
  },
  {
    href: "/admin/sessions/removal-requests",
    label: "Removal requests",
    isActive: (p) => p.startsWith("/admin/sessions/removal-requests"),
  },
];

export function RentalsSubnav() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Rentals sections"
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
