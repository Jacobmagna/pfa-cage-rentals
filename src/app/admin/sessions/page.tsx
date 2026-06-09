import Link from "next/link";
import { and, asc, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { resources, sessionsBilling, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { listActiveCoaches } from "@/lib/server/coaches";
import { parsePfaInput, pfaDayEnd } from "@/lib/timezone";
import { FiltersForm } from "./_components/filters-form";
import { defaultSessionsRange, DEFAULT_RANGE_DAYS } from "./filters.logic";
import { SessionsClient } from "./_components/sessions-client";

// Admin sessions page. Filterable row-level view of bookings —
// complements the day-grid (`/admin/schedule`) and the per-coach
// rollup (`/admin/reports`). All filter state lives in the URL,
// so the page is shareable and the browser back button works.
//
// Default window straddles today: last 14 days through next 14 days,
// so both recent-past and upcoming sessions show without the admin
// touching the filter bar. To go further out the admin extends the
// date range. (See defaultSessionsRange in filters.logic.ts.)
//
// Coach + resource filter dropdowns only list active coaches /
// active resources, but the table itself joins unfiltered — so
// existing sessions by a since-deleted coach or for a since-
// deactivated resource still appear and can still be edited /
// deleted in the dialog.

const MAX_ROWS = 500;

type RawSearchParams = Promise<{
  from?: string | string[];
  to?: string | string[];
  coachIds?: string | string[];
  resourceIds?: string | string[];
}>;

export default async function AdminSessionsPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  const filters = normalizeFilters(params);

  const whereClauses = [
    gte(sessionsBilling.startAt, filters.fromInstant),
    lt(sessionsBilling.startAt, filters.toInstantExclusive),
  ];
  if (filters.coachIds.length > 0) {
    whereClauses.push(inArray(sessionsBilling.coachId, filters.coachIds));
  }
  if (filters.resourceIds.length > 0) {
    whereClauses.push(inArray(sessionsBilling.resourceId, filters.resourceIds));
  }

  const [rows, coachOptions, resourceOptions, allCoaches] = await Promise.all([
    db
      .select({
        id: sessionsBilling.id,
        coachId: sessionsBilling.coachId,
        coachName: users.name,
        coachEmail: users.email,
        resourceId: sessionsBilling.resourceId,
        resourceName: resources.name,
        resourceType: resources.type,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        note: sessionsBilling.note,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling)
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(and(...whereClauses))
      .orderBy(desc(sessionsBilling.startAt))
      .limit(MAX_ROWS + 1),
    // Dialog dropdown — only active coaches can have new sessions assigned.
    listActiveCoaches(),
    db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        sortOrder: resources.sortOrder,
      })
      .from(resources)
      .where(eq(resources.active, true))
      .orderBy(asc(resources.sortOrder)),
    // Filter dropdown — active coaches only.
    listActiveCoaches(),
  ]);

  const truncated = rows.length > MAX_ROWS;
  const visibleRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

  return (
    <>
      <Link
        href="/admin/cage-rentals"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Rentals
      </Link>

      <div className="mb-8 space-y-2">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Rentals</h1>
        <p className="text-sm text-fg-muted">
          Filter and edit individual bookings. Defaults to the last{" "}
          {DEFAULT_RANGE_DAYS} days through the next {DEFAULT_RANGE_DAYS} days.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
      </div>

      <FiltersForm
        coaches={allCoaches}
        resources={resourceOptions}
        values={{
          from: filters.from,
          to: filters.to,
          coachIds: filters.coachIds,
          resourceIds: filters.resourceIds,
        }}
        isFiltered={filters.isFiltered}
      />

      <SessionsClient
        rows={visibleRows}
        coachOptions={coachOptions}
        resourceOptions={resourceOptions}
        truncated={truncated}
        maxRows={MAX_ROWS}
      />
    </>
  );
}

type NormalizedFilters = {
  from: string;
  to: string;
  fromInstant: Date;
  toInstantExclusive: Date;
  coachIds: string[];
  resourceIds: string[];
  /** True if any filter differs from the default (last 14 days → next 14 days, all coaches/resources). */
  isFiltered: boolean;
};

function normalizeFilters(input: {
  from?: string | string[];
  to?: string | string[];
  coachIds?: string | string[];
  resourceIds?: string | string[];
}): NormalizedFilters {
  const fromInput = pickFirst(input.from);
  const toInput = pickFirst(input.to);

  // Defaults in PFA TZ: today − 14 days through today + 14 days, so the
  // window straddles "now" and shows both recent-past and upcoming
  // sessions. Pure date math lives in defaultSessionsRange (tested).
  // Each bound defaults independently: an explicitly supplied From/To is
  // honored exactly; only an absent/blank bound falls back to the default.
  const defaults = defaultSessionsRange(new Date());

  const from = isDateInput(fromInput) ? fromInput : defaults.from;
  const to = isDateInput(toInput) ? toInput : defaults.to;

  const coachIds = toArray(input.coachIds).filter(Boolean);
  const resourceIds = toArray(input.resourceIds).filter(Boolean);

  const fromInstant = parsePfaInput(from, "00:00");
  // `to` is inclusive — convert to exclusive upper bound at next PFA midnight.
  const toInstantExclusive = pfaDayEnd(parsePfaInput(to, "00:00"));

  const isFiltered =
    from !== defaults.from ||
    to !== defaults.to ||
    coachIds.length > 0 ||
    resourceIds.length > 0;

  return {
    from,
    to,
    fromInstant,
    toInstantExclusive,
    coachIds,
    resourceIds,
    isFiltered,
  };
}

function pickFirst(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function isDateInput(v: string | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}
