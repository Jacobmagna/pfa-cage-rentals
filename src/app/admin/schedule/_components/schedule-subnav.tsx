"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Schedule sub-nav (DEC-17 — pure additive nav chrome). Mirrors
// attendance-subnav.tsx: active by pathname, aria-current="page" on the
// active item, gold underline, keyboard-accessible focus ring, AA
// semantic tokens. Two sub-tabs: Cage Rentals (the existing, unchanged
// cage schedule at /admin/schedule) and Programs (FEAT-15).
//
// Cage Rentals is active ONLY on the exact /admin/schedule path so it
// doesn't stay lit while a child route (Programs) is open. Programs is
// active when the pathname starts with /admin/schedule/programs.

type SubTab = {
  href: string;
  label: string;
  isActive: (pathname: string) => boolean;
};

const SUB_TABS: SubTab[] = [
  {
    href: "/admin/schedule",
    label: "Cage Rentals",
    isActive: (p) => p === "/admin/schedule",
  },
  {
    href: "/admin/schedule/programs",
    label: "Programs",
    isActive: (p) => p.startsWith("/admin/schedule/programs"),
  },
];

export function ScheduleSubnav() {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Schedule sections" className="border-b border-line">
      <ul className="flex gap-1 overflow-x-auto whitespace-nowrap -mb-px">
        {SUB_TABS.map((tab) => {
          const isActive = tab.isActive(pathname);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-flex items-center px-3 sm:px-4 py-3 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded-sm",
                  isActive
                    ? "border-gold text-gold-strong"
                    : "border-transparent text-fg-muted hover:text-fg",
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
