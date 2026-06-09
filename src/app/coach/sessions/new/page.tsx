import Link from "next/link";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { LogSessionExperience } from "./_components/log-session-experience";
import type { ResourceOption } from "../_components/types";

// Coach session log page. Server component — auths the user,
// fetches active resources, hands off to the client form. Public
// server action `logOwnSession` enforces coachId = self regardless
// of any client-supplied value.

export default async function NewSessionPage() {
  const session = await requireSession();

  const resourceOptions: ResourceOption[] = await db
    .select({
      id: resources.id,
      name: resources.name,
      type: resources.type,
    })
    .from(resources)
    .where(eq(resources.active, true))
    .orderBy(resources.sortOrder);

  const displayName = session.user.name ?? session.user.email ?? "Coach";

  return (
    <>
      {/* Calendar view is wider than the form; the experience component
          manages each view's own width. Cap the whole page at max-w-5xl
          so the calendar grid has room. */}
      <div className="max-w-5xl mx-auto">
        <Link
          href="/coach"
          className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>

        <div className="space-y-1.5 mb-7">
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Log a cage rental
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            New rental
          </h1>
          <p className="text-sm text-fg-muted">
            Logged for{" "}
            <span className="text-fg font-medium">{displayName}</span>.
          </p>
        </div>

        <LogSessionExperience
          resources={resourceOptions}
          coachId={session.user.id ?? ""}
          coachName={displayName}
        />
      </div>
    </>
  );
}
