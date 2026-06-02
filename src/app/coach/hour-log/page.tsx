import { Clock } from "lucide-react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { programs } from "@/db/schema";
import { requireSession } from "@/lib/authz";
import { HourLogForm, type ProgramOption } from "./_components/hour-log-form";

// Coach hour-log page. Server component — auths the user, loads every
// active program (DEC-29: coaches may log against ANY active program,
// not just assigned ones), hands off to the client form. Public server
// action `logOwnHour` enforces coachId = self regardless of any
// client-supplied value.

export default async function CoachHourLogPage() {
  const session = await requireSession();
  const { user } = session;

  const programOptions: ProgramOption[] = await db
    .select({ id: programs.id, name: programs.name })
    .from(programs)
    .where(eq(programs.active, true))
    .orderBy(programs.name);

  const displayName = user.name ?? user.email;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">Hour Log</h1>

      {programOptions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface shadow-[var(--shadow-sm)] py-16 text-center">
          <Clock className="h-8 w-8 text-gold" aria-hidden="true" />
          <p className="text-fg-muted">
            No active programs yet — ask an admin to add one.
          </p>
        </div>
      ) : (
        <div className="max-w-md">
          <div className="space-y-1.5 mb-7">
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-fg-muted">
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
