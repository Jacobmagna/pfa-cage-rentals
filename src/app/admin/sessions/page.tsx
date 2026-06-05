import Link from "next/link";
import { and, asc, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { resources, sessionsBilling, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
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

const VALID_USE_TYPES = new Set(["hitting", "pitching"] as const);

type RawSearchParams = Promise<{
  from?: string | string[];
  to?: string | string[];
  coachIds?: string | string[];
  resourceIds?: string | string[];
  useTypes?: string | string[];
  teamRental?: string | string[];
  pfaReferred?: string | string[];
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
  if (filters.useTypes.length > 0) {
    whereClauses.push(inArray(sessionsBilling.useType, filters.useTypes));
  }
  // teamRental filter: ["yes"] → only team rentals, ["no"] → only non,
  // ["yes","no"] or empty → no filter. Anything else (e.g. junk URL
  // param) collapses to no filter via the normalizer.
  if (filters.teamRental.length === 1) {
    whereClauses.push(
      eq(sessionsBilling.isTeamRental, filters.teamRental[0] === "yes"),
    );
  }
  if (filters.pfaReferred.length === 1) {
    whereClauses.push(
      eq(sessionsBilling.pfaReferred, filters.pfaReferred[0] === "yes"),
    );
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
        useType: sessionsBilling.useType,
        note: sessionsBilling.note,
        isTeamRental: sessionsBilling.isTeamRental,
        pfaReferred: sessionsBilling.pfaReferred,
        isOnline: sessionsBilling.isOnline,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
      })
      .from(sessionsBilling)
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(and(...whereClauses))
      .orderBy(desc(sessionsBilling.startAt))
      .limit(MAX_ROWS + 1),
    // Dialog dropdown — only active coaches can have new sessions assigned.
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(isNull(users.deletedAt))
      .orderBy(asc(users.name)),
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
    // Filter dropdown — coaches role only, active only. (Dialog dropdown
    // above allows admin too, since admins can also be booked.)
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
  ]);

  const truncated = rows.length > MAX_ROWS;
  const visibleRows = truncated ? rows.slice(0, MAX_ROWS) : rows;

  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-8 space-y-2">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Admin
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Sessions</h1>
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
          useTypes: filters.useTypes,
          teamRental: filters.teamRental,
          pfaReferred: filters.pfaReferred,
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
  useTypes: ("hitting" | "pitching")[];
  /** ["yes"] / ["no"] / ["yes","no"] or empty. Length 1 → filter; otherwise no filter. */
  teamRental: ("yes" | "no")[];
  /** Same yes/no semantics as teamRental. */
  pfaReferred: ("yes" | "no")[];
  /** True if any filter differs from the default (last 14 days → next 14 days, all coaches/resources/uses/rentals). */
  isFiltered: boolean;
};

const VALID_YES_NO = new Set(["yes", "no"] as const);

function normalizeFilters(input: {
  from?: string | string[];
  to?: string | string[];
  coachIds?: string | string[];
  resourceIds?: string | string[];
  useTypes?: string | string[];
  teamRental?: string | string[];
  pfaReferred?: string | string[];
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
  const useTypes = toArray(input.useTypes).filter(
    (t): t is "hitting" | "pitching" =>
      VALID_USE_TYPES.has(t as "hitting" | "pitching"),
  );
  const teamRental = toArray(input.teamRental).filter(
    (t): t is "yes" | "no" => VALID_YES_NO.has(t as "yes" | "no"),
  );
  const pfaReferred = toArray(input.pfaReferred).filter(
    (t): t is "yes" | "no" => VALID_YES_NO.has(t as "yes" | "no"),
  );

  const fromInstant = parsePfaInput(from, "00:00");
  // `to` is inclusive — convert to exclusive upper bound at next PFA midnight.
  const toInstantExclusive = pfaDayEnd(parsePfaInput(to, "00:00"));

  const isFiltered =
    from !== defaults.from ||
    to !== defaults.to ||
    coachIds.length > 0 ||
    resourceIds.length > 0 ||
    useTypes.length > 0 ||
    teamRental.length === 1 ||
    pfaReferred.length === 1;

  return {
    from,
    to,
    fromInstant,
    toInstantExclusive,
    coachIds,
    resourceIds,
    useTypes,
    teamRental,
    pfaReferred,
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
