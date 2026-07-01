"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, GitMerge } from "lucide-react";
import { PFA_TIMEZONE } from "@/lib/timezone";
import { MergeCoachDialog } from "./merge-coach-dialog";
import { ListSearch } from "@/app/_components/list-search";
import { nameMatchesQuery } from "@/app/_components/list-search.logic";

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
  lastActivityAt: Date | null;
  sessionsThisMonth: number;
  owedThisMonthCents: number;
  isSynthetic: boolean;
};

export type MergeTarget = {
  id: string;
  name: string | null;
  email: string;
};

type SortKey =
  | "name"
  | "email"
  | "joinedAt"
  | "lastActivityAt"
  | "sessionsThisMonth"
  | "owedThisMonthCents";
type SortDir = "asc" | "desc";

// Per-column sensible default direction. Numbers default desc
// (biggest first — the natural "who owes the most" framing).
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: "asc",
  email: "asc",
  joinedAt: "desc",
  lastActivityAt: "desc",
  sessionsThisMonth: "desc",
  owedThisMonthCents: "desc",
};

export function CoachesTable({
  rows,
  mergeTargets,
}: {
  rows: CoachRow[];
  mergeTargets: MergeTarget[];
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({
    key: "name",
    dir: "asc",
  });
  const [mergeSource, setMergeSource] = useState<CoachRow | null>(null);
  const [query, setQuery] = useState("");

  // Client-side name/email filter, composed with the existing sort:
  // filter the rows first, then sort the survivors.
  const sorted = useMemo(() => {
    const copy = rows.filter((r) =>
      // Coaches are keyed by email, so match on name (or email fallback)
      // AND the email itself.
      nameMatchesQuery(query, [r.name ?? r.email, r.email]),
    );
    copy.sort((a, b) => {
      const cmp = compareByKey(a, b, sort.key);
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort, query]);

  const onHeaderClick = (key: SortKey) => {
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );
  };

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-12 text-center">
        <p className="text-sm font-medium text-fg">No coaches yet</p>
        <p className="mt-1.5 text-sm text-fg-muted">
          The first time a coach signs in, they&apos;ll appear here
          automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ListSearch
        value={query}
        onChange={setQuery}
        placeholder="Search coaches…"
        label="Search coaches by name or email"
        resultCount={sorted.length}
        totalCount={rows.length}
      />

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-12 text-center">
          <p className="text-sm font-medium text-fg">
            No coaches match &ldquo;{query.trim()}&rdquo;.
          </p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Try a different name or email, or clear the search.
          </p>
        </div>
      ) : (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)]">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-[11px] font-semibold uppercase tracking-wider text-fg-muted border-b border-line bg-surface-2/50">
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
              label="Last activity"
              col="lastActivityAt"
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
              label="Owes PFA"
              col="owedThisMonthCents"
              align="right"
              sort={sort}
              onClick={onHeaderClick}
            />
            <th
              scope="col"
              className="px-4 py-3 font-semibold text-right sr-only"
            >
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.id}
              className="border-t border-line hover:bg-surface-2 transition-colors"
            >
              <td className="px-4 py-3 max-w-[18rem]">
                <div className="flex min-w-0 items-center gap-2">
                  <Link
                    href={`/admin/coaches/${row.id}`}
                    className="min-w-0 truncate text-fg hover:underline transition-colors font-medium"
                    title={row.name ?? row.email}
                  >
                    {row.name ?? row.email}
                  </Link>
                  {row.isSynthetic ? (
                    <span
                      className="inline-flex shrink-0 items-center rounded-full bg-surface-2 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-fg-muted ring-1 ring-inset ring-line"
                      title="Created by the historical import — has no auth tie to a real user"
                    >
                      Imported
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="px-4 py-3 text-fg-muted text-xs">{row.email}</td>
              <td className="px-4 py-3 text-fg-muted font-mono tnum tabular-nums text-xs whitespace-nowrap">
                {formatJoined(row.joinedAt)}
              </td>
              <td className="px-4 py-3 text-fg-muted font-mono tnum tabular-nums text-xs whitespace-nowrap">
                {row.lastActivityAt === null ? (
                  <span className="text-fg-subtle">—</span>
                ) : (
                  formatLastActivity(row.lastActivityAt)
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tnum tabular-nums text-fg-muted">
                {row.sessionsThisMonth === 0 ? (
                  <span className="text-fg-subtle">—</span>
                ) : (
                  row.sessionsThisMonth
                )}
              </td>
              <td className="px-4 py-3 text-right font-mono tnum tabular-nums font-semibold text-fg">
                {row.owedThisMonthCents === 0 ? (
                  <span className="text-fg-subtle font-normal">—</span>
                ) : (
                  formatCents(row.owedThisMonthCents)
                )}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap">
                {row.isSynthetic ? (
                  <button
                    type="button"
                    onClick={() => setMergeSource(row)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 h-7 text-[11px] font-medium text-fg-muted hover:text-fg hover:-translate-y-px shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 transition"
                    title="Re-point this synthetic coach's sessions to a real coach"
                  >
                    <GitMerge className="h-3 w-3" />
                    Merge
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
      )}

      <MergeCoachDialog
        open={mergeSource !== null}
        onClose={() => setMergeSource(null)}
        source={mergeSource}
        targets={mergeTargets}
      />
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
        "px-4 py-3 font-semibold",
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
          <Icon className="h-3 w-3 text-fg" />
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
    case "lastActivityAt":
      return (a.lastActivityAt?.getTime() ?? 0) - (b.lastActivityAt?.getTime() ?? 0);
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

function formatLastActivity(d: Date): string {
  return d.toLocaleString("en-US", {
    timeZone: PFA_TIMEZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
