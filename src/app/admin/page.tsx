import Link from "next/link";
import { requireRole } from "@/lib/authz";
import { AppShell } from "../_components/app-shell";
import { EditableName } from "../_components/editable-name";

export default async function AdminHome() {
  const session = await requireRole("admin");

  return (
    <AppShell role="admin">
      <div className="space-y-2 mb-10">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Dashboard
        </p>
        <h1 className="text-3xl font-bold tracking-tight">
          Welcome back,{" "}
          <EditableName initialName={session.user.name ?? "Admin"} />
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
        <Link
          href="/admin/reports"
          className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong"
        >
          <p className="text-[10px] uppercase tracking-[0.18em] text-gold">
            Live
          </p>
          <h3 className="mt-1 text-base font-semibold text-fg">Reports</h3>
          <p className="mt-1.5 text-sm text-fg-muted">
            Per-coach billing breakdown by resource type. Excel export lands in E2.
          </p>
        </Link>
        <Link
          href="/admin/schedule"
          className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong"
        >
          <p className="text-[10px] uppercase tracking-[0.18em] text-gold">
            Live
          </p>
          <h3 className="mt-1 text-base font-semibold text-fg">
            Schedule grid
          </h3>
          <p className="mt-1.5 text-sm text-fg-muted">
            Excel-style day view of every cage / bullpen / weight room booking.
          </p>
        </Link>
        <Link
          href="/admin/coaches"
          className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong"
        >
          <p className="text-[10px] uppercase tracking-[0.18em] text-gold">
            Live
          </p>
          <h3 className="mt-1 text-base font-semibold text-fg">Coaches</h3>
          <p className="mt-1.5 text-sm text-fg-muted">
            Roster with month-to-date activity + per-coach rate overrides.
          </p>
        </Link>
        <Link
          href="/admin/audit"
          className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong"
        >
          <p className="text-[10px] uppercase tracking-[0.18em] text-gold">
            Live
          </p>
          <h3 className="mt-1 text-base font-semibold text-fg">Audit log</h3>
          <p className="mt-1.5 text-sm text-fg-muted">
            Every create / update / delete to sessions, blocks, and rates.
          </p>
        </Link>
        <Link
          href="/admin/import"
          className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong"
        >
          <p className="text-[10px] uppercase tracking-[0.18em] text-gold">
            Live
          </p>
          <h3 className="mt-1 text-base font-semibold text-fg">Historical import</h3>
          <p className="mt-1.5 text-sm text-fg-muted">
            Upload source_data.xlsx → preview + review → commit past sessions.
          </p>
        </Link>
      </div>
    </AppShell>
  );
}

