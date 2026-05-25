import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { ArrowLeft, CalendarPlus } from "lucide-react";
import { db } from "@/db";
import { resources, sessionsBilling } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { SessionsHistoryClient, type HistoryRow } from "./_components/sessions-history-client";
import type { ResourceOption } from "./_components/types";

const PAGE_SIZE = 20;

// Coach session history. Server-component: requires a session,
// fetches the coach's own sessions filtered by coachId (URL-guessing
// another coach's id is moot because the WHERE clause is server-side).
// Pagination is offset-based via ?page=N — cursor would be overkill
// for v1 scale (~100 rows per coach per month).
//
// Money is admin-only: this surface used to render charge totals via
// billing.ts, but coach-facing dollar amounts are deferred to a V2
// invoice section (rates are variable per coach and Dad invoices
// manually). Coaches see what they booked, not what they earned.

type SearchParams = Promise<{ page?: string }>;

export default async function CoachSessionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const page = Math.max(1, parseInt(params.page ?? "1", 10) || 1);

  // Total count for pagination + empty-state branching.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessionsBilling)
    .where(eq(sessionsBilling.coachId, session.user.id));
  const totalCount = count;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  // Empty path skips the rest — render the friendly CTA card and exit.
  if (totalCount === 0) {
    return (
      <>
        <div className="max-w-2xl">
          <BackLink />
          <PageHeader />
          <EmptyState />
        </div>
      </>
    );
  }

  const [rawRows, activeResources] = await Promise.all([
    db
      .select({
        id: sessionsBilling.id,
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
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(eq(sessionsBilling.coachId, session.user.id))
      .orderBy(desc(sessionsBilling.startAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
      })
      .from(resources)
      .where(eq(resources.active, true))
      .orderBy(resources.sortOrder),
  ]);

  const rows: HistoryRow[] = rawRows.map((r) => ({
    id: r.id,
    resourceId: r.resourceId,
    resourceName: r.resourceName,
    resourceType: r.resourceType,
    startAt: r.startAt,
    endAt: r.endAt,
    useType: r.useType,
    note: r.note,
    isTeamRental: r.isTeamRental,
    pfaReferred: r.pfaReferred,
    isOnline: r.isOnline,
  }));

  const resourceOptions: ResourceOption[] = activeResources;

  return (
    <>
      <div className="max-w-2xl">
        <BackLink />
        <PageHeader />
        <SessionsHistoryClient
          rows={rows}
          resources={resourceOptions}
          page={page}
          totalPages={totalPages}
          totalCount={totalCount}
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
      <h1 className="text-2xl font-bold tracking-tight">My sessions</h1>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-line/60 bg-surface/40 p-10 text-center">
      <div className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-surface text-gold mb-4">
        <CalendarPlus className="h-5 w-5" />
      </div>
      <h2 className="text-base font-semibold text-fg">No sessions yet</h2>
      <p className="mt-1.5 text-sm text-fg-muted max-w-xs mx-auto">
        Log your first session and it&apos;ll show up here.
      </p>
      <Link
        href="/coach/sessions/new"
        className="mt-5 inline-flex items-center justify-center rounded-md border border-gold/40 bg-gold/10 text-gold hover:bg-gold/20 px-4 h-10 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/40"
      >
        Log your first session
      </Link>
    </div>
  );
}
