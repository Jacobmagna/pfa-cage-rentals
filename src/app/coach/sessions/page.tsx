import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { ArrowLeft, CalendarPlus } from "lucide-react";
import { db } from "@/db";
import {
  coachRateOverrides,
  resources,
  sessionsBilling,
} from "@/db/schema";
import { requireSession } from "@/lib/authz";
import {
  chargeForSession,
  type RateOverride,
  type ResourceType,
} from "@/lib/billing";
import { AppShell } from "@/app/_components/app-shell";
import { SessionsHistoryClient, type HistoryRow } from "./_components/sessions-history-client";
import type { ResourceOption } from "./_components/types";

const PAGE_SIZE = 20;

// Coach session history. Server-component: requires a session,
// fetches the coach's own sessions filtered by coachId (URL-guessing
// another coach's id is moot because the WHERE clause is server-side).
// Pagination is offset-based via ?page=N — cursor would be overkill
// for v1 scale (~100 rows per coach per month).
//
// Rate / total is computed at render time using billing.ts. We fetch
// the coach's overrides once (typically 0–3 rows) and let
// chargeForSession decide override-vs-default per session.

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
      <AppShell role="coach">
        <div className="max-w-2xl">
          <BackLink />
          <PageHeader />
          <EmptyState />
        </div>
      </AppShell>
    );
  }

  // Fetch session rows + coach's overrides in parallel.
  const [rawRows, overrides, activeResources] = await Promise.all([
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
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(eq(sessionsBilling.coachId, session.user.id))
      .orderBy(desc(sessionsBilling.startAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
    db
      .select()
      .from(coachRateOverrides)
      .where(eq(coachRateOverrides.coachId, session.user.id)),
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

  // Adapt DB overrides to the billing.ts shape.
  const billingOverrides: RateOverride[] = overrides.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));

  const rows: HistoryRow[] = rawRows.map((r) => {
    const charge = chargeForSession(
      {
        coachId: session.user.id,
        resourceType: r.resourceType as ResourceType,
        startAt: r.startAt,
        endAt: r.endAt,
      },
      billingOverrides,
    );
    return {
      id: r.id,
      resourceId: r.resourceId,
      resourceName: r.resourceName,
      resourceType: r.resourceType,
      startAt: r.startAt,
      endAt: r.endAt,
      useType: r.useType,
      note: r.note,
      slots: charge.slots,
      ratePerSlotCents: charge.ratePer30MinCents,
      totalCents: charge.totalCents,
    };
  });

  const resourceOptions: ResourceOption[] = activeResources;

  return (
    <AppShell role="coach">
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
    </AppShell>
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
    <div className="rounded-lg border border-line bg-surface p-10 text-center">
      <div className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-surface-2 text-gold mb-4">
        <CalendarPlus className="h-5 w-5" />
      </div>
      <h2 className="text-base font-semibold text-fg">No sessions yet</h2>
      <p className="mt-1.5 text-sm text-fg-muted max-w-xs mx-auto">
        Log your first session and it&apos;ll show up here with the rate and
        total.
      </p>
      <Link
        href="/coach/sessions/new"
        className="mt-5 inline-flex items-center justify-center rounded-md border border-gold/40 bg-gold/10 text-gold hover:bg-gold/20 px-4 h-10 text-sm font-medium transition-colors"
      >
        Log your first session
      </Link>
    </div>
  );
}
