import Link from "next/link";
import { eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { resources } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { LogSessionForm } from "./_components/log-session-form";
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

  const displayName = session.user.name ?? session.user.email;

  return (
    <>
      <div className="max-w-md mx-auto">
        <Link
          href="/coach"
          className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back
        </Link>

        <div className="space-y-1.5 mb-7">
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Log a session
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
            New session
          </h1>
          <p className="text-sm text-fg-muted">
            Logged for{" "}
            <span className="text-fg font-medium">{displayName}</span>.
          </p>
        </div>

        <LogSessionForm resources={resourceOptions} />
      </div>
    </>
  );
}
