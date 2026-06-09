"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Coach Hour Log sub-nav (QA10 W3.7). Two sub-tabs:
//   Log hours → /coach/hour-log (the confirm-the-schedule + manual form)
//   History   → /coach/hour-log/history (the coach's own logged hours)
//
// Modeled on the admin hour-log subnav (active by pathname, aria-current
// on the active item, gold underline, keyboard focus ring, AA tokens).
// "Log hours" is active ONLY on the exact /coach/hour-log path so it
// doesn't stay lit while History is open; History is active when the
// pathname starts with /coach/hour-log/history. The two are disjoint, so
// they never both light up.

type SubTab = {
  href: string;
  label: string;
  isActive: (pathname: string) => boolean;
};

const SUB_TABS: SubTab[] = [
  {
    href: "/coach/hour-log",
    label: "Log work",
    isActive: (p) => p === "/coach/hour-log",
  },
  {
    href: "/coach/hour-log/history",
    label: "History",
    isActive: (p) => p.startsWith("/coach/hour-log/history"),
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
