import { asc } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { AppShell } from "@/app/_components/app-shell";
import { ImportForm } from "./_components/import-form";

export default async function AdminImportPage() {
  await requireRole("admin");

  // Pre-fetch the coach roster so the "map to existing coach" dropdown
  // can render without an extra round-trip per row.
  const coaches = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .orderBy(asc(users.name), asc(users.email));

  return (
    <AppShell role="admin">
      <div className="space-y-2 mb-8">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Stage I — Historical import
        </p>
        <h1 className="text-3xl font-bold tracking-tight">Import past sessions</h1>
        <p className="text-sm text-fg-muted max-w-2xl">
          Upload <code className="text-xs">source_data.xlsx</code> (or a fresh weekly
          file). The dry-run preview groups every distinct raw name; review the unmatched
          ones, choose what to do with each, then commit.
        </p>
      </div>
      <ImportForm coaches={coaches} />
    </AppShell>
  );
}
