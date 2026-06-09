import Link from "next/link";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { ArrowLeft, Archive } from "lucide-react";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import {
  ArchiveCoachesClient,
  type ArchivedCoachRow,
} from "./_components/archive-coaches-client";

// /admin/coaches/archive — archived (soft-deleted) coaches (#28). Lists
// every role=coach row with a non-null deletedAt and offers a per-row
// Restore that clears deletedAt and returns the coach to the active list.
// Mirrors the athlete archive view's structure. Archived coaches are
// anonymized (name "Former coach", placeholder email) per the J9 privacy
// promise — restoring brings the row back but not the original identity.
export default async function CoachesArchivePage() {
  await requireRole("admin");

  const coachRows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(and(eq(users.role, "coach"), isNotNull(users.deletedAt)))
    .orderBy(desc(users.deletedAt));

  const rows: ArchivedCoachRow[] = coachRows.map((c) => ({
    id: c.id,
    name: c.name,
    email: c.email,
    // isNotNull filter guarantees deletedAt is present; assert for the type.
    archivedAt: c.deletedAt as Date,
  }));

  return (
    <>
      <Link
        href="/admin/coaches"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All coaches
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Coaches
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {rows.length} archived {rows.length === 1 ? "coach" : "coaches"}
        </h1>
        <p className="text-sm text-fg-muted">
          Coaches archived from their detail page. Restore one to return them
          to the active roster and let them sign back in.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <Archive
            className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">No archived coaches.</p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Archive a coach from their detail page to remove them from active
            lists.
          </p>
        </div>
      ) : (
        <ArchiveCoachesClient coaches={rows} />
      )}
    </>
  );
}
