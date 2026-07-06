import Link from "next/link";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { ArrowLeft, CalendarPlus } from "lucide-react";
import { db } from "@/db";
import { resources, sessionsBilling } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { totalFromSnapshot } from "@/lib/billing";
import { pendingRemovalSessionIds } from "@/lib/server/session-removal-actions";
import { parsePfaInput, pfaDayEnd } from "@/lib/timezone";
import { SessionsHistoryClient, type HistoryRow } from "./_components/sessions-history-client";
import type { ResourceOption } from "./_components/types";
import { parseHistoryFilters } from "./filters.logic";

const PAGE_SIZE = 20;

// Coach session history. Server-component: requires a session,
// fetches the coach's own sessions filtered by coachId (URL-guessing
// another coach's id is moot because the WHERE clause is server-side).
// Pagination is offset-based via ?page=N — cursor would be overkill
// for v1 scale (~100 rows per coach per month).
//
// Each rental row shows what the coach OWES for it: the cost is
// computed read-side from the row's snapshotted ratePer30MinCents via
// totalFromSnapshot (immutable — a later rate change never re-bills a
// past rental), plus the per-hour rate as a caption. No running total
// here — the coach's balance lives on the Home dashboard.

type SearchParams = Promise<{
  page?: string;
  from?: string | string[];
  to?: string | string[];
  resourceId?: string | string[];
}>;

export default async function CoachSessionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const coachId = session.user.id;
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);

  // Active resources drive the filter dropdown AND validate the URL's
  // resourceId (a stale/unknown id is dropped, not turned into an empty
  // result). Fetched up front so it's available for both the empty state
  // and the filtered query.
  const activeResources = await db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
    })
    .from(resources)
    .where(eq(resources.active, true))
    .orderBy(resources.sortOrder);

  const resourceOptions: ResourceOption[] = activeResources;
  const validResourceIds = new Set(activeResources.map((r) => r.id));

  // Validate + normalize the URL filters (facility-TZ date strings stay as
  // "YYYY-MM-DD" here; converted to UTC instants below). Default = all.
  const filters = parseHistoryFilters(params, validResourceIds);

  // Same WHERE for BOTH the count and the rows queries, so pagination + the
  // "N sessions" label reflect the FILTERED set. coachId is always pinned
  // server-side — a client-supplied coachId is never trusted.
  const whereClauses = [eq(sessionsBilling.coachId, coachId)];
  if (filters.from) {
    whereClauses.push(
      gte(sessionsBilling.startAt, parsePfaInput(filters.from, "00:00")),
    );
  }
  if (filters.to) {
    // `to` is an inclusive day — convert to the exclusive next-PFA-midnight
    // bound (facility TZ, DST-safe) so sessions on the To date are included.
    whereClauses.push(
      lt(sessionsBilling.startAt, pfaDayEnd(parsePfaInput(filters.to, "00:00"))),
    );
  }
  if (filters.resourceId) {
    whereClauses.push(eq(sessionsBilling.resourceId, filters.resourceId));
  }
  const where = and(...whereClauses);

  // Unfiltered "does this coach have ANY sessions?" check — decides whether
  // to show the first-run CTA vs the filter bar. Kept separate from the
  // filtered count so an empty filter result still shows the bar (to clear).
  const [{ count: lifetimeCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.coachId, coachId));

  // First-run path: this coach has never logged a session. Skip filters
  // entirely and show the friendly CTA.
  if (lifetimeCount === 0) {
    return (
      <>
        <div className="max-w-2xl mx-auto">
          <BackLink />
          <PageHeader />
          <EmptyState />
        </div>
      </>
    );
  }

  const [[{ count }], rawRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessionsBilling)
      .where(where),
    db
      .select({
        id: sessionsBilling.id,
        resourceId: sessionsBilling.resourceId,
        resourceName: resources.name,
        resourceType: resources.type,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        note: sessionsBilling.note,
        ratePer30MinCents: sessionsBilling.ratePer30MinCents,
        isGroupSession: sessionsBilling.isGroupSession,
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(where)
      .orderBy(desc(sessionsBilling.startAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ]);

  const totalCount = count;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Which of this coach's rentals already have a PENDING removal request —
  // so a past row shows a "Removal requested" chip instead of the button.
  const pendingRemoval = await pendingRemovalSessionIds(coachId);

  // "Past" = the rental has started (startAt <= now). Past rentals can no
  // longer be deleted/edited-billable by the coach — they request removal.
  const now = new Date();
  const rows: HistoryRow[] = rawRows.map((r) => ({
    id: r.id,
    resourceId: r.resourceId,
    resourceName: r.resourceName,
    resourceType: r.resourceType,
    startAt: r.startAt,
    endAt: r.endAt,
    note: r.note,
    // What the coach owes for this rental, read from the row's own
    // snapshotted rate (never recomputed from current overrides).
    ratePer30MinCents: r.ratePer30MinCents,
    amountCents: totalFromSnapshot(r.startAt, r.endAt, r.ratePer30MinCents),
    isGroupSession: r.isGroupSession,
    isPast: r.startAt <= now,
    removalPending: pendingRemoval.has(r.id),
  }));

  return (
    <>
      <div className="max-w-2xl mx-auto">
        <BackLink />
        <PageHeader />
        <SessionsHistoryClient
          rows={rows}
          resources={resourceOptions}
          page={page}
          totalPages={totalPages}
          totalCount={totalCount}
          filters={filters}
        />
      </div>
    </>
  );
}

function BackLink() {
  return (
    <Link
      href="/coach"
      className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back
    </Link>
  );
}

function PageHeader() {
  return (
    <div className="space-y-1.5 mb-7">
      <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
        History
      </p>
      <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">My rentals</h1>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] p-10 text-center">
      <div className="inline-flex items-center justify-center h-10 w-10 rounded-full border border-line bg-surface-2 text-gold mb-4">
        <CalendarPlus className="h-5 w-5" />
      </div>
      <h2 className="text-base font-semibold text-fg">No rentals yet</h2>
      <p className="mt-1.5 text-sm text-fg-muted max-w-xs mx-auto">
        Log your first rental and it&apos;ll show up here.
      </p>
      <Link
        href="/coach/sessions/new"
        className="mt-5 inline-flex items-center justify-center rounded-lg border border-gold/40 bg-gold/10 text-gold-strong hover:bg-gold/20 px-4 h-10 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
      >
        Log your first rental
      </Link>
    </div>
  );
}
