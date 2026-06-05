"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Attendance sub-nav (DEC-22). Mirrors _components/tab-nav.tsx: active
// by pathname, aria-current="page" on the active item, gold underline,
// keyboard-accessible focus ring, AA semantic tokens. Two sub-tabs:
// Roster (this feature) and Attendance by Program (placeholder).

type SubTab = {
  href: string;
  label: string;
};

const SUB_TABS: SubTab[] = [
  { href: "/admin/attendance/roster", label: "Roster" },
  { href: "/admin/attendance/by-program", label: "Attendance by Program" },
  { href: "/admin/attendance/by-player", label: "By player" },
  { href: "/admin/attendance/archive", label: "Archive" },
];

export function AttendanceSubnav() {
  const pathname = usePathname() ?? "";

  return (
    <nav
      aria-label="Attendance sections"
      className="border-b border-line bg-surface"
    >
      <ul className="flex gap-1 overflow-x-auto whitespace-nowrap -mb-px">
        {SUB_TABS.map((tab) => {
          const isActive = pathname === tab.href;
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
