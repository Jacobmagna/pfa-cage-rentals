import { Clock } from "lucide-react";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { programs } from "@/db/schema";
import { coachProgramIds, requireSession } from "@/lib/authz";
import { HourLogForm, type ProgramOption } from "./_components/hour-log-form";

// Coach hour-log page. Server component — auths the user, loads the
// programs they may log against (admins → all active; coaches → their
// assigned + active programs), hands off to the client form. Public
// server action `logOwnHour` enforces coachId = self regardless of
// any client-supplied value.

export default async function CoachHourLogPage() {
  const session = await requireSession();
  const { user } = session;

  let programOptions: ProgramOption[] = [];
  if (user.role === "admin") {
    programOptions = await db
      .select({ id: programs.id, name: programs.name })
      .from(programs)
      .where(eq(programs.active, true))
      .orderBy(programs.name);
  } else {
    const ids = await coachProgramIds(user.id);
    if (ids.length > 0) {
      programOptions = await db
        .select({ id: programs.id, name: programs.name })
        .from(programs)
        .where(and(inArray(programs.id, ids), eq(programs.active, true)))
        .orderBy(programs.name);
    }
  }

  const displayName = user.name ?? user.email;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Hour Log</h1>

      {programOptions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-line bg-surface py-16 text-center">
          <Clock className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No programs assigned yet — ask an admin to add you to a program.
          </p>
        </div>
      ) : (
        <div className="max-w-md">
          <div className="space-y-1.5 mb-7">
            <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
              Log your hours
            </p>
            <p className="text-sm text-fg-muted">
              Logged for{" "}
              <span className="text-fg font-medium">{displayName}</span>.
            </p>
          </div>

          <HourLogForm programs={programOptions} />
        </div>
      )}
    </div>
  );
}
