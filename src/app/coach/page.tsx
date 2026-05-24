import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireSession } from "@/lib/authz";
import { AppShell } from "../_components/app-shell";

export default async function CoachHome() {
  const session = await requireSession();

  return (
    <AppShell role="coach">
      <div className="max-w-2xl space-y-2 mb-10">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Welcome
        </p>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight break-words">
          {session.user.name?.split(" ")[0] ?? session.user.email?.split("@")[0]}
        </h1>
      </div>

      <Link
        href="/coach/sessions/new"
        className="group block rounded-lg border border-line bg-surface hover:border-line-strong hover:bg-surface-2 p-6 max-w-2xl transition-colors"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
              Today
            </p>
            <h3 className="mt-1 text-base font-semibold">Log a session</h3>
            <p className="mt-1.5 text-sm text-fg-muted">
              Date, time, resource, optional note. Use it right after a lesson.
            </p>
          </div>
          <ArrowRight className="h-4 w-4 mt-1 text-fg-muted group-hover:text-gold transition-colors" />
        </div>
      </Link>
    </AppShell>
  );
}
