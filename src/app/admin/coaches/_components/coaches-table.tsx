"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { PFA_TIMEZONE } from "@/lib/timezone";

// Client-side sortable table. The page pre-aggregates one row per
// coach, so sorting here is purely O(n log n) on a small array — no
// re-fetch round-trip. Sort state lives in this component (not URL)
// because /admin/coaches isn't a link-shared surface and the cost of
// a refresh-loses-sort is low.

export type CoachRow = {
  id: string;
  name: string | null;
  email: string;
  joinedAt: Date;
  sessionsThisMonth: number;
  owedThisMonthCents: number;
};

type SortKey =
  | "name"
  | "email"
  | "joinedAt"
  | "sessionsThisMonth"
  | "owedThisMonthCents";
type SortDir = "asc" | "desc";

// Per-column sensible default direction. Numbers default desc
// (biggest first — the natural "who owes the most" framing).
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  email: "asc",
  joinedAt: "desc",
  sessionsThisMonth: "desc",
  owedThisMonthCents: "desc",
};

export function CoachesTable({ rows }: { rows: CoachRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareByKey(a, b, sort.key);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  const onHeaderClick = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-line/60 bg-surface/40 p-12 text-center">
        <p className="text-sm font-medium text-fg">No coaches yet</p>
        <p className="mt-1.5 text-sm text-fg-muted">
          The first time a coach signs in, they&apos;ll appear here
          automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-[11px] uppercase tracking-[0.14em] text-fg-subtle border-b border-line">
          <tr>
            <SortHeader
              label="Coach"
              col="name"
              align="left"
              sort={sort}
              onClick={onHeaderClick}
            />
            <SortHeader
              label="Email"
              col="email"
              align="left"
              sort={sort}
              onClick={onHeaderClick}
            />
            <SortHeader
              label="Joined"
              col="joinedAt"
              align="left"
              sort={sort}
              onClick={onHeaderClick}
            />
            <SortHeader
              label="Sessions"
              col="sessionsThisMonth"
              align="right"
              sort={sort}
              onClick={onHeaderClick}
            />
            <SortHeader
              label="Owed"
              col="owedThisMonthCents"
              align="right"
              sort={sort}
              onClick={onHeaderClick}
            />
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.id}
              className="border-b border-line/50 last:border-b-0 hover:bg-surface/60 transition-colors"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/admin/coaches/${row.id}`}
                  className="text-fg hover:text-gold transition-colors font-medium"
                >
                  {row.name ?? row.email}
                </Link>
              </td>
              <td className="px-4 py-3 text-fg-muted text-xs">{row.email}</td>
              <td className="px-4 py-3 text-fg-muted font-mono tabular-nums text-xs whitespace-nowrap">
                {formatJoined(row.joinedAt)}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-fg-muted">
                {row.sessionsThisMonth === 0 ? (
                  <span className="text-fg-subtle">—</span>
                ) : (
                  row.sessionsThisMonth
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-fg">
                {row.owedThisMonthCents === 0 ? (
                  <span className="text-fg-subtle font-normal">—</span>
                ) : (
                  formatCents(row.owedThisMonthCents)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortHeader({
  label,
  col,
  align,
  sort,
  onClick,
}: {
  label: string;
  col: SortKey;
  align: "left" | "right";
  sort: { key: SortKey; dir: SortDir };
  onClick: (col: SortKey) => void;
}) {
  const active = sort.key === col;
  // Inactive headers don't render an arrow — keeps the row quiet. The
  // ArrowUpDown reveals on hover only via the group class. Active
  // header shows the directional arrow in gold.
  const Icon = sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      className={[
        "px-4 py-3 font-medium",
        align === "right" ? "text-right" : "text-left",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={() => onClick(col)}
        className={[
          "group inline-flex items-center gap-1.5 transition-colors",
          active ? "text-fg" : "text-fg-subtle hover:text-fg",
        ].join(" ")}
      >
        {label}
        {active ? (
          <Icon className="h-3 w-3 text-gold" />
        ) : (
          <ArrowUpDown className="h-3 w-3 text-fg-disabled opacity-0 transition-opacity group-hover:opacity-100" />
        )}
      </button>
    </th>
  );
}

function compareByKey(a: CoachRow, b: CoachRow, key: SortKey): number {
  switch (key) {
    case "name": {
      const an = (a.name ?? a.email).toLowerCase();
      const bn = (b.name ?? b.email).toLowerCase();
      return an.localeCompare(bn);
    }
    case "email":
      return a.email.localeCompare(b.email);
    case "joinedAt":
      return a.joinedAt.getTime() - b.joinedAt.getTime();
    case "sessionsThisMonth":
      return a.sessionsThisMonth - b.sessionsThisMonth;
    case "owedThisMonthCents":
      return a.owedThisMonthCents - b.owedThisMonthCents;
  }
}

function formatJoined(d: Date): string {
  return d.toLocaleDateString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
