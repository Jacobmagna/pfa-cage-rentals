import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { requireSession } from "@/lib/authz";
import { EditableName } from "../_components/editable-name";

export default async function CoachHome() {
  const session = await requireSession();

  return (
    <>
      <div className="max-w-2xl space-y-2 mb-10">
        <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
          Welcome
        </p>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight break-words">
          <EditableName
            initialName={session.user.name ?? session.user.email?.split("@")[0] ?? "Coach"}
          />
        </h1>
      </div>

      <div className="grid gap-3 max-w-2xl sm:grid-cols-2">
        <DashboardCard
          href="/coach/sessions/new"
          eyebrow="Today"
          title="Log a session"
          body="Date, time, resource, optional note. Use it right after a lesson."
        />
        <DashboardCard
          href="/coach/sessions"
          eyebrow="History"
          title="My sessions"
          body="Review what you've logged, edit a slot, or correct a mistake."
        />
      </div>
    </>
  );
}

function DashboardCard({
  href,
  eyebrow,
  title,
  body,
}: {
  href: string;
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      href={href}
      className="group block rounded-lg border border-line bg-surface hover:border-line-strong hover:bg-surface-2 p-6 transition-colors"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-[0.18em] text-fg-subtle">
            {eyebrow}
          </p>
          <h3 className="mt-1 text-base font-semibold">{title}</h3>
          <p className="mt-1.5 text-sm text-fg-muted">{body}</p>
        </div>
        <ArrowRight className="h-4 w-4 mt-1 text-fg-muted group-hover:text-gold transition-colors" />
      </div>
    </Link>
  );
}
