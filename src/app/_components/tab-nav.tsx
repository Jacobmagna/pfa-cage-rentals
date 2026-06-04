"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeTab, type TabKey } from "./tab-nav.logic";

type Tab = {
  key: TabKey;
  label: string;
};

// Admin tab list: Home is the leftmost landing tab (QA4-C1); Cage Rentals
// now lives at its own /admin/cage-rentals route.
const ADMIN_TABS: Tab[] = [
  { key: "home", label: "Home" },
  { key: "cage", label: "Cage Rentals" },
  { key: "hour-log", label: "Hour Log" },
  { key: "attendance", label: "Attendance" },
  { key: "records", label: "Billing & Records" },
];

// Coach tab list: no Home tab; Schedule is coach-only (admin reaches its
// schedule via /admin/schedule, which keeps lighting Cage Rentals).
const COACH_TABS: Tab[] = [
  { key: "cage", label: "Cage Rentals" },
  { key: "hour-log", label: "Hour Log" },
  { key: "attendance", label: "Attendance" },
  { key: "schedule", label: "Schedule" },
];

function hrefFor(key: TabKey, base: string): string {
  switch (key) {
    case "home":
      return base;
    case "cage":
      // Admin's Cage Rentals now lives at its own route; coach's cage tab
      // stays at /coach.
      return base === "/admin" ? "/admin/cage-rentals" : base;
    case "hour-log":
      return `${base}/hour-log`;
    case "attendance":
      return `${base}/attendance`;
    case "schedule":
      return `${base}/schedule`;
    case "records":
      // Admin-only tab; coaches never receive it, so the admin base is fine.
      return `${base}/records`;
  }
}

export function TabNav({ role }: { role: "admin" | "coach" }) {
  const pathname = usePathname() ?? "";
  const base = role === "admin" ? "/admin" : "/coach";
  const tabs = role === "coach" ? COACH_TABS : ADMIN_TABS;
  const current = activeTab(pathname, role);

  return (
    <nav aria-label="Sections" className="min-w-0">
      <ul className="flex items-center gap-1 overflow-x-auto whitespace-nowrap">
        {tabs.map((tab) => {
          const isActive = tab.key === current;
          return (
            <li key={tab.key}>
              <Link
                href={hrefFor(tab.key, base)}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "inline-flex items-center rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold",
                  isActive
                    ? "bg-gold/10 text-gold-strong font-semibold"
                    : "text-fg-muted font-medium hover:text-fg",
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
