"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Hour Log sub-nav (QA2-8 — pure additive nav chrome; QA3-1 added the
// Programs sub-tab). Modeled on schedule-subnav.tsx: active by pathname,
// aria-current="page" on the active item, gold underline,
// keyboard-accessible focus ring, AA semantic tokens. Three sub-tabs:
// Hours (the existing, unchanged hour-log table at /admin/hour-log),
// Programs (program CRUD moved from /admin/programs to
// /admin/hour-log/programs), and Program Schedule (the program schedule
// grid at /admin/hour-log/schedule).
//
// Hours is active ONLY on the exact /admin/hour-log path so it doesn't
// stay lit while a child route (Programs / Program Schedule) is open.
// Programs is active when the pathname starts with
// /admin/hour-log/programs; Program Schedule when it starts with
// /admin/hour-log/schedule. The two prefixes are disjoint, so they
// never both light up.

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
    href: "/admin/hour-log/programs",
    label: "Work",
    isActive: (p) => p.startsWith("/admin/hour-log/programs"),
  },
  {
    href: "/admin/hour-log/schedule",
    label: "Work Schedule",
    isActive: (p) => p.startsWith("/admin/hour-log/schedule"),
  },
];

export function HourLogSubnav() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Work Log sections"
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
