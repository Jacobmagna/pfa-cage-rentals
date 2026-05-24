import Link from "next/link";
import { requireRole } from "@/lib/authz";
import { AppShell } from "../_components/app-shell";

export default async function AdminHome() {
  const session = await requireRole("admin");

  return (
    <AppShell role="admin">
      <div className="space-y-2 mb-10">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Dashboard
        </p>
        <h1 className="text-3xl font-bold tracking-tight">
          Welcome back, {session.user.name?.split(" ")[0] ?? "Admin"}
        </h1>
        <p className="text-sm text-fg-muted">
          Phase 1 foundation is live. Schedule grid, reports, coach
          management, and rate overrides land in later phases.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/admin/sessions"
          className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong"
        >
          <p className="text-[10px] uppercase tracking-[0.18em] text-gold">
            Live
          </p>
          <h3 className="mt-1 text-base font-semibold text-fg">Sessions</h3>
          <p className="mt-1.5 text-sm text-fg-muted">
            Log, edit, and review every cage / bullpen / weight room booking.
          </p>
        </Link>
        <PlaceholderCard
          eyebrow="Phase 4"
          title="Reports"
          description="Monthly Excel export by coach and date range."
        />
        <PlaceholderCard
          eyebrow="Phase 5"
          title="Schedule grid"
          description="The Excel-style grid view, real-time and editable."
        />
        <PlaceholderCard
          eyebrow="Phase 7"
          title="Coaches & rates"
          description="Manage per-coach rate overrides."
        />
        <PlaceholderCard
          eyebrow="Phase 7"
          title="Block-off times"
          description="Mark cages unavailable for closure / maintenance."
        />
        <PlaceholderCard
          eyebrow="Phase 8"
          title="Historical import"
          description="One-time backfill from source_data.xlsx."
        />
      </div>
    </AppShell>
  );
}

function PlaceholderCard({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong">
      <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
        {eyebrow}
      </p>
      <h3 className="mt-1 text-base font-semibold text-fg">{title}</h3>
      <p className="mt-1.5 text-sm text-fg-muted">{description}</p>
    </div>
  );
}
