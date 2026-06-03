"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Hour Log sub-nav (QA2-8 — pure additive nav chrome). Modeled on
// schedule-subnav.tsx: active by pathname, aria-current="page" on the
// active item, gold underline, keyboard-accessible focus ring, AA
// semantic tokens. Two sub-tabs: Hours (the existing, unchanged
// hour-log table at /admin/hour-log) and Program Schedule (the program
// schedule grid moved from /admin/schedule/programs to
// /admin/hour-log/schedule).
//
// Hours is active ONLY on the exact /admin/hour-log path so it doesn't
// stay lit while a child route (Program Schedule) is open. Program
// Schedule is active when the pathname starts with
// /admin/hour-log/schedule.

type SubTab = {
  href: string;
  label: string;
  isActive: (pathname: string) => boolean;
};

const SUB_TABS: SubTab[] = [
  {
    href: "/admin/hour-log",
    label: "Hours",
    isActive: (p) => p === "/admin/hour-log",
  },
  {
    href: "/admin/hour-log/schedule",
    label: "Program Schedule",
    isActive: (p) => p.startsWith("/admin/hour-log/schedule"),
  },
];

export function HourLogSubnav() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Hour Log sections"
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
