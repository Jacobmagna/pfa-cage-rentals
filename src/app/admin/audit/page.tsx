import Link from "next/link";
import { asc, inArray } from "drizzle-orm";
import { ArrowLeft, ChevronLeft, ChevronRight } from "lucide-react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  AUDIT_PAGE_SIZE,
  auditFiltersToQueryString,
  normalizeAuditFilters,
} from "@/lib/audit/filters";
import { fetchAuditPage } from "@/lib/audit/fetch";
import { FiltersForm } from "./_components/filters-form";
import { AuditTable } from "./_components/audit-table";

// /admin/audit — filterable view of every audit_log entry. Closes
// out Stage H. Filters live in URL searchParams so links are
// shareable + browser-back works (matches /admin/reports pattern).
//
// Actor dropdown shows every user who has ever appeared as an actor,
// PLUS every admin (so an admin who hasn't done anything yet is still
// pickable). Restricting to "users who have written audit rows" would
// drop newly-promoted admins from the picker.

type RawSearchParams = Promise<{
  from?: string;
  to?: string;
  actorId?: string;
  entityTypes?: string | string[];
  actions?: string | string[];
  page?: string;
}>;

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: RawSearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;

  const filters = normalizeAuditFilters(params);

  // Actor list + page in parallel. The actor list is small (<100
  // rows for the foreseeable future); no point paginating.
  const [actors, result] = await Promise.all([
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
      })
      .from(users)
      .where(inArray(users.role, ["admin", "coach"]))
      // Admins first (so the people who actually mutate things are
      // at the top of the dropdown), then alpha by name → email.
      .orderBy(asc(users.role), asc(users.name), asc(users.email)),
    fetchAuditPage(filters),
  ]);

  const totalPages = Math.max(
    1,
    Math.ceil(result.total / result.pageSize),
  );
  const page = Math.min(filters.page, totalPages);

  const baseQuery = (p: number) =>
    `/admin/audit?${auditFiltersToQueryString(filters, { page: p })}`;

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
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Audit log
        </p>
        <h1 className="text-3xl font-semibold tracking-tight tnum">
          {result.total === 0
            ? "No entries"
            : `${result.total.toLocaleString()} ${result.total === 1 ? "entry" : "entries"}`}
        </h1>
        <p className="text-sm text-fg-muted">
          Every create / update / delete to sessions, blocks, and rate
          overrides. Filtered range defaults to the last 7 days.
        </p>
        <p className="text-xs italic text-fg-subtle md:hidden">
          This page is designed for desktop. Rotate your device or use a
          laptop for the full experience.
        </p>
      </div>

      <FiltersForm
        actors={actors.map((a) => ({
          id: a.id,
          name: a.name,
          email: a.email,
          role: a.role as "admin" | "coach",
        }))}
        values={filters}
      />

      <AuditTable rows={result.rows} />

      {totalPages > 1 ? (
        <nav
          aria-label="Pagination"
          className="mt-5 flex items-center justify-between gap-3 text-sm"
        >
          <p className="text-fg-muted tnum">
            Page {page} of {totalPages} · {AUDIT_PAGE_SIZE} per page
          </p>
          <div className="flex items-center gap-2">
            <PageLink
              href={page > 1 ? baseQuery(page - 1) : null}
              dir="prev"
            />
            <PageLink
              href={page < totalPages ? baseQuery(page + 1) : null}
              dir="next"
            />
          </div>
        </nav>
      ) : null}
    </>
  );
}

function PageLink({
  href,
  dir,
}: {
  href: string | null;
  dir: "prev" | "next";
}) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  const label = dir === "prev" ? "Previous" : "Next";
  if (!href) {
    return (
      <span
        aria-disabled
        className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 h-9 text-fg-subtle opacity-40 cursor-not-allowed"
      >
        {dir === "prev" ? <Icon className="h-4 w-4" /> : null}
        {label}
        {dir === "next" ? <Icon className="h-4 w-4" /> : null}
      </span>
    );
  }
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface px-3 h-9 text-fg-muted shadow-[var(--shadow-sm)] hover:text-fg hover:-translate-y-px hover:shadow-[var(--shadow-md)] transition"
    >
      {dir === "prev" ? <Icon className="h-4 w-4" /> : null}
      {label}
      {dir === "next" ? <Icon className="h-4 w-4" /> : null}
    </Link>
  );
}
