import Link from "next/link";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import {
  blockedTimes,
  resources,
  sessionsBilling,
  users,
} from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { AppShell } from "@/app/_components/app-shell";
import { ScheduleGrid } from "./_components/schedule-grid";
import { WeekNav } from "./_components/week-nav";

// Read-only Excel-style schedule grid for admins. Single-day view
// with a week strip for quick navigation. F2 layers SWR polling on
// top for soft real-time. Editing happens in Stage G (click-to-edit,
// drag-to-move).
//
// URL state: ?date=YYYY-MM-DD (defaults to today).

type SearchParams = Promise<{ date?: string }>;

export default async function AdminSchedulePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  await requireRole("admin");
  const params = await searchParams;
  const selectedDate = parseDateInput(params.date) ?? startOfToday();

  const dayStart = new Date(selectedDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const [activeResources, sessionRows, blockRows] = await Promise.all([
    db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        sortOrder: resources.sortOrder,
      })
      .from(resources)
      .where(eq(resources.active, true))
      .orderBy(asc(resources.sortOrder)),
    db
      .select({
        id: sessionsBilling.id,
        coachName: users.name,
        coachEmail: users.email,
        resourceId: sessionsBilling.resourceId,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        useType: sessionsBilling.useType,
        note: sessionsBilling.note,
      })
      .from(sessionsBilling)
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .where(
        and(
          gte(sessionsBilling.startAt, dayStart),
          lt(sessionsBilling.startAt, dayEnd),
        ),
      )
      .orderBy(asc(sessionsBilling.startAt)),
    db
      .select()
      .from(blockedTimes)
      .where(
        and(
          gte(blockedTimes.startAt, dayStart),
          lt(blockedTimes.startAt, dayEnd),
        ),
      ),
  ]);

  const sessions = sessionRows.map((r) => ({
    id: r.id,
    coachName: r.coachName ?? r.coachEmail,
    resourceId: r.resourceId,
    startAt: r.startAt,
    endAt: r.endAt,
    useType: r.useType,
    note: r.note,
  }));

  const blocks = blockRows.map((b) => ({
    id: b.id,
    resourceId: b.resourceId,
    startAt: b.startAt,
    endAt: b.endAt,
    reason: b.reason,
  }));

  const dateLabel = selectedDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const sessionCount = sessions.length;

  return (
    <AppShell role="admin">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1.5 text-xs text-fg-muted hover:text-fg mb-6 transition-colors"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Schedule
          </p>
          <h1 className="text-2xl font-bold tracking-tight">{dateLabel}</h1>
          <p className="text-sm text-fg-muted">
            {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
            {blocks.length > 0
              ? ` · ${blocks.length} ${blocks.length === 1 ? "block" : "blocks"}`
              : ""}
          </p>
        </div>
      </div>

      <WeekNav selectedDate={selectedDate} />

      <ScheduleGrid
        resources={activeResources}
        sessions={sessions}
        blocks={blocks}
      />
    </AppShell>
  );
}

function parseDateInput(s: string | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
