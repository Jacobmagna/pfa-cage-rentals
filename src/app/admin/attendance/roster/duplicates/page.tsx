import Link from "next/link";
import { ArrowLeft, Users } from "lucide-react";
import { requireRole } from "@/lib/authz";
import { loadDuplicateGroups } from "@/lib/server/athlete-actions";
import { DuplicatesClient } from "../_components/duplicates-client";

// /admin/attendance/roster/duplicates — review possible duplicate athletes
// (#17 roster dedup). Admin-only: athletes are minors' PII and never surface
// on a public route. Thin server shell — guards the role, loads the grouped
// duplicates (read-only, no actor), and hands the groups to the client island
// that owns the survivor-pick / merge / dismiss interactivity. Mirrors the
// coaches archive page's back-link + header structure.
export default async function DuplicatesPage() {
  await requireRole("admin");

  const { groups } = await loadDuplicateGroups();

  return (
    <>
      <Link
        href="/admin/attendance/roster"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to roster
      </Link>

      <div className="mb-6 space-y-1.5">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Roster
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Review duplicates
        </h1>
        <p className="text-sm text-fg-muted">
          Athletes that look like the same person. Keep one record and merge the
          rest, or mark them as different people so they stop being flagged.
        </p>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-line bg-surface p-12 text-center shadow-[var(--shadow-sm)]">
          <Users
            className="mx-auto mb-3 h-7 w-7 text-fg-subtle"
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-fg">
            No possible duplicates 🎉
          </p>
          <p className="mt-1.5 text-sm text-fg-muted">
            Every athlete on the roster looks distinct. Check back after the
            next import.
          </p>
        </div>
      ) : (
        <DuplicatesClient groups={groups} />
      )}
    </>
  );
}
