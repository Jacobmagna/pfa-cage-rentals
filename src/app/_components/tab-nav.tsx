"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeTab, type TabKey } from "./tab-nav.logic";

type Tab = {
  key: TabKey;
  label: string;
};

const TABS: Tab[] = [
  { key: "cage", label: "Cage Rentals" },
  { key: "hour-log", label: "Hour Log" },
  { key: "attendance", label: "Attendance" },
];

function hrefFor(key: TabKey, base: string): string {
  switch (key) {
    case "cage":
      return base;
    case "hour-log":
      return `${base}/hour-log`;
    case "attendance":
      return `${base}/attendance`;
  }
}

export function TabNav({ role }: { role: "admin" | "coach" }) {
  const pathname = usePathname() ?? "";
  const base = role === "admin" ? "/admin" : "/coach";
  const current = activeTab(pathname);

  return (
    <nav
      aria-label="Sections"
      className="border-b border-line bg-surface"
    >
      <div className="mx-auto w-full max-w-7xl px-6 lg:px-8">
        <ul className="flex gap-1 overflow-x-auto whitespace-nowrap -mb-px">
          {TABS.map((tab) => {
            const isActive = tab.key === current;
            return (
              <li key={tab.key}>
                <Link
                  href={hrefFor(tab.key, base)}
                  aria-current={isActive ? "page" : undefined}
                  className={[
                    "inline-flex items-center px-3 sm:px-4 py-3 text-sm font-medium border-b-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold rounded-sm",
                    isActive
                      ? "border-gold text-gold"
                      : "border-transparent text-fg-muted hover:text-fg",
                  ].join(" ")}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
