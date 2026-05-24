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
        <h1 className="text-3xl font-bold tracking-tight">
          {session.user.name?.split(" ")[0] ?? session.user.email}
        </h1>
        <p className="text-sm text-fg-muted">
          You&apos;ll log your sessions here once Phase 3 ships. For now,
          this is just confirmation that your account works.
        </p>
      </div>

      <div className="rounded-lg border border-line bg-surface p-6 max-w-2xl">
        <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
          Coming next
        </p>
        <h3 className="mt-1 text-base font-semibold">Log a session</h3>
        <p className="mt-1.5 text-sm text-fg-muted">
          Date, start &amp; end time, resource (Cage 1–5, Bullpen 1–2, Weight
          Room), optional note. Mobile-friendly form for use right after a
          lesson.
        </p>
      </div>
    </AppShell>
  );
}
