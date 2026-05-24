import Link from "next/link";
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import { ArrowLeft, Download } from "lucide-react";
import { db } from "@/db";
import {
  coachRateOverrides,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  aggregateReport,
  type AggregateSessionInput,
} from "@/lib/reports/aggregate";
import type { RateOverride, ResourceType } from "@/lib/billing";
import { AppShell } from "@/app/_components/app-shell";
import { FiltersForm } from "./_components/filters-form";
import { ReportPreview } from "./_components/report-preview";

// Admin reports page. Filters live in the URL (`?from=&to=&coachIds=&resourceTypes=`)
// so links are shareable and the browser back button just works.
// Server component: parse filters → build query → aggregate → render.
//
// "All checked" / "none checked" both render as "no filter" in the
// URL — the form trims to whatever boxes are checked. We treat
// missing as "all" so a fresh visit (no params) shows the full month.

type RawSearchParams = Promise<{
  from?: string;
  to?: string;
  coachIds?: string | string[];
  resourceTypes?: string | string[];
}>;

const VALID_RESOURCE_TYPES = new Set<ResourceType>([
  "cage",
  "bullpen",
  "weight_room",
]);

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  // Defaults: first → last of current month.
  const today = new Date();
  const defaultFrom = formatDateInput(
    new Date(today.getFullYear(), today.getMonth(), 1),
  );
  const defaultTo = formatDateInput(
    new Date(today.getFullYear(), today.getMonth() + 1, 0),
  );

  const fromStr = isDateInput(params.from) ? params.from : defaultFrom;
  const toStr = isDateInput(params.to) ? params.to : defaultTo;

  const coachIds = toArray(params.coachIds).filter(Boolean);
  const resourceTypes = toArray(params.resourceTypes).filter((t): t is ResourceType =>
    VALID_RESOURCE_TYPES.has(t as ResourceType),
  );

  // Build the inclusive range as [fromMidnight, dayAfterToMidnight).
  // Sessions whose startAt is on the `to` day are included; the
  // exclusive upper bound avoids the off-by-one trap of `<= to`.
  const fromDate = parseDateInput(fromStr);
  const toDateExclusive = parseDateInput(toStr);
  toDateExclusive.setDate(toDateExclusive.getDate() + 1);

  const conditions = [
    gte(sessionsBilling.startAt, fromDate),
    lt(sessionsBilling.startAt, toDateExclusive),
  ];
  if (coachIds.length > 0) {
    conditions.push(inArray(sessionsBilling.coachId, coachIds));
  }
  if (resourceTypes.length > 0 && resourceTypes.length < 3) {
    conditions.push(inArray(resources.type, resourceTypes));
  }

  // Fetch in parallel: coaches list (for the filter form),
  // session rows (joined with resources + users), overrides (small
  // table; fetching all is cheaper than filtering by coachId set).
  const [coachOptions, sessionRows, overrideRows] = await Promise.all([
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.role, "coach"))
      .orderBy(asc(users.name), asc(users.email)),
    db
      .select({
        sessionId: sessionsBilling.id,
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
      })
      .from(sessionsBilling)
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .where(and(...conditions))
      .orderBy(asc(sessionsBilling.startAt)),
    db.select().from(coachRateOverrides),
  ]);

  const aggregateInputs: AggregateSessionInput[] = sessionRows.map((r) => ({
    sessionId: r.sessionId,
    coachId: r.coachId,
    coachName: r.coachName,
    coachEmail: r.coachEmail,
    resourceId: r.resourceId,
    resourceName: r.resourceName,
    resourceType: r.resourceType,
    startAt: r.startAt,
    endAt: r.endAt,
    useType: r.useType,
    note: r.note,
  }));

  const overrides: RateOverride[] = overrideRows.map((o) => ({
    coachId: o.coachId,
    resourceType: o.resourceType,
    ratePer30MinCents: o.ratePer30MinCents,
  }));

  const report = aggregateReport(aggregateInputs, overrides);

  // Download URL preserves the same filter params so the workbook
  // matches what's previewed. Wired up in E2.
  const downloadHref = `/admin/reports/download?${buildQueryString({
    from: fromStr,
    to: toStr,
    coachIds,
    resourceTypes,
  })}`;

  return (
    <AppShell role="admin">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Billing reports
          </p>
          <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
          <p className="text-sm text-fg-muted">
            Per-coach billing breakdown by resource type. Defaults to the
            current month.
          </p>
        </div>

        <a
          href={downloadHref}
          aria-disabled="true"
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface px-4 h-10 text-sm font-medium text-fg-muted cursor-not-allowed pointer-events-none opacity-50"
          title="Excel export lands in E2"
        >
          <Download className="h-4 w-4" />
          Download Excel
        </a>
      </div>

      <FiltersForm
        coaches={coachOptions}
        values={{
          from: fromStr,
          to: toStr,
          coachIds,
          resourceTypes,
        }}
      />

      <ReportPreview
        detail={report.detail}
        summary={report.summary}
        grandTotalCents={report.grandTotalCents}
      />
    </AppShell>
  );
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function isDateInput(v: string | string[] | undefined): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function parseDateInput(s: string): Date {
  // Local midnight — matches the "user picked this day on the calendar" intent.
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildQueryString(p: {
  from: string;
  to: string;
  coachIds: string[];
  resourceTypes: string[];
}): string {
  const sp = new URLSearchParams();
  sp.set("from", p.from);
  sp.set("to", p.to);
  for (const id of p.coachIds) sp.append("coachIds", id);
  for (const t of p.resourceTypes) sp.append("resourceTypes", t);
  return sp.toString();
}
