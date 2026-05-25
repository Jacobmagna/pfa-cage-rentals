import { desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { resources, sessionsBilling, users } from "@/db/schema";
import { requireRole } from "@/lib/authz";
import { SessionsClient } from "./_components/sessions-client";

// Admin sessions page. Pulls the latest 50 bookings + all
// coaches + all active resources, hands them to a single client
// component (SessionsClient) that owns the table + create/edit
// dialog state. Splitting into more granular client components
// would mean prop drilling the coaches/resources lists; for v1 the
// page is small enough that one client island is the cleanest
// trade.

export default async function AdminSessionsPage() {
  await requireRole("admin");

  const [rows, coachOptions, resourceOptions] = await Promise.all([
    db
      .select({
        id: sessionsBilling.id,
        coachId: sessionsBilling.coachId,
        coachName: users.name,
        coachEmail: users.email,
        resourceId: sessionsBilling.resourceId,
        resourceName: resources.name,
        resourceType: resources.type,
        startAt: sessionsBilling.startAt,
        endAt: sessionsBilling.endAt,
        useType: sessionsBilling.useType,
        note: sessionsBilling.note,
      })
      .from(sessionsBilling)
      .innerJoin(users, eq(sessionsBilling.coachId, users.id))
      .innerJoin(resources, eq(sessionsBilling.resourceId, resources.id))
      .orderBy(desc(sessionsBilling.startAt))
      .limit(50),
    // The session-list table joins users unfiltered above, so an
    // already-recorded session by a deleted coach still shows under
    // "Former coach". This dropdown is for the create/edit dialog —
    // only active coaches can have new sessions assigned to them.
    db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
      })
      .from(users)
      .where(isNull(users.deletedAt))
      .orderBy(users.name),
    db
      .select({
        id: resources.id,
        name: resources.name,
        type: resources.type,
        sortOrder: resources.sortOrder,
      })
      .from(resources)
      .where(eq(resources.active, true))
      .orderBy(resources.sortOrder),
  ]);

  return (
    <>
      <div className="mb-8 flex items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-[0.18em] text-fg-muted">
            Admin
          </p>
          <h1 className="text-3xl font-bold tracking-tight">Sessions</h1>
          <p className="text-sm text-fg-muted">
            Latest 50 bookings across every cage, bullpen, and weight room.
          </p>
        </div>
      </div>

      <SessionsClient
        rows={rows}
        coachOptions={coachOptions}
        resourceOptions={resourceOptions}
      />
    </>
  );
}
