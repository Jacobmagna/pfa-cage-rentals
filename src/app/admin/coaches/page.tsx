import Link from "next/link";
import { and, asc, eq, gte, isNull, lt } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  coachRateOverrides,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  chargeForSession,
  type RateOverride,
  type ResourceType,
} from "@/lib/billing";
import { formatPfaMonthYear } from "@/lib/timezone";
import { isSyntheticUserEmail } from "@/lib/server/user-actions";
import { CoachesTable, type CoachRow } from "./_components/coaches-table";

// /admin/coaches — list of every user with role=coach plus their
// month-to-date activity. "This month" = first-of-month (local TZ)
// through start-of-tomorrow, matching the report page default range.
//
// Server-rendered; the client island handles sorting on top of the
// already-aggregated rows. For a roster of <100 coaches the round-trip
// to re-sort server-side adds latency without buying anything.

export default async function AdminCoachesPage() {
  await requireRole("admin");

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEndExclusive = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    1,
  );

  const [coachRows, sessionRows, overrideRows] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(and(eq(users.role, "coach"), isNull(users.deletedAt)))
      .orderBy(asc(users.name), asc(users.email)),
    db
      .select({
        coachId: sessionsBilling.coachId,
        resourceType: resources.type,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .where(
        and(
          gte(sessionsBilling.startAt, monthStart),
          lt(sessionsBilling.startAt, monthEndExclusive),
        ),
      ),
    db.select().from(coachRateOverrides),
  ]);

  const overrides: RateOverride[] = overrideRows.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));

  // Pre-aggregate per coach. Doing it server-side means the client
  // island doesn't carry the full session list; it gets one row per
  // coach.
  const totals = new Map<string, { count: number; cents: number }>();
  for (const s of sessionRows) {
    const charge = chargeForSession(
      {
        coachId: s.coachId,
        resourceType: s.resourceType as ResourceType,
        startAt: s.startAt,
        endAt: s.endAt,
      },
      overrides,
    );
    const entry = totals.get(s.coachId) ?? { count: 0, cents: 0 };
    entry.count += 1;
    entry.cents += charge.totalCents;
    totals.set(s.coachId, entry);
  }

  const rows: CoachRow[] = coachRows.map((c) => {
    const t = totals.get(c.id);
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      joinedAt: c.createdAt,
      sessionsThisMonth: t?.count ?? 0,
      owedThisMonthCents: t?.cents ?? 0,
      isSynthetic: isSyntheticUserEmail(c.email),
    };
  });

  // Merge targets = every coach. Synthetic-into-synthetic is allowed
  // because the historical import can create multiple pseudo-coaches
  // for what's logically one entity (e.g. "PFA Travel" + "PFA Summer
  // Travel" + "PFA Travel JT" should consolidate into a single PFA
  // Travel pseudo-coach). The merge dialog itself excludes the source
  // row from the dropdown.
  const mergeTargets = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
  }));

  const monthLabel = formatPfaMonthYear(now);

  return (
    <>
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Coaches
        </p>
        <h1 className="text-2xl font-bold tracking-tight">
          {rows.length} {rows.length === 1 ? "coach" : "coaches"}
        </h1>
        <p className="text-sm text-fg-muted">
          Month-to-date activity for {monthLabel}. Click a coach to view
          their detail page.
        </p>
      </div>

      <CoachesTable rows={rows} mergeTargets={mergeTargets} />
    </>
  );
}
