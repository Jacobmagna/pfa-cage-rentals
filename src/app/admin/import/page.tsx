import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/authz";
import { listActiveCoaches } from "@/lib/server/coaches";
import { ImportForm } from "./_components/import-form";

export default async function AdminImportPage() {
  await requireRole("admin");

  // Pre-fetch the coach roster so the "map to existing coach" dropdown
  // can render without an extra round-trip per row. Only active coaches
  // (role=coach, not soft-deleted) appear — re-mapping an Excel row to a
  // "Former coach" would just re-create the privacy leak we promised to
  // fix, and admins / name-less accounts were never valid mapping targets.
  const coaches = await listActiveCoaches();

  return (
    <>
      <Link
        href="/admin/records"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Billing &amp; Records
      </Link>

      <div className="space-y-2 mb-8">
        <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
          Stage I — Historical import
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Import past sessions</h1>
        <p className="text-sm text-fg-muted max-w-2xl">
          Upload <code className="text-xs">source_data.xlsx</code> (or a fresh weekly
          file). The dry-run preview groups every distinct raw name; review the unmatched
          ones, choose what to do with each, then commit.
        </p>
      </div>
      <ImportForm coaches={coaches} />
    </>
  );
}
