// Data fetch for the audit log viewer. Joins audit_log with users
// (actor) and returns one page of rows + a total count for paging.
//
// The diff column is jsonb; we hand it back as `unknown` and let the
// renderer decide how to display it (a `<details>` with formatted
// JSON in v1; H4 doesn't try to render type-specific diff prose).

import { and, count, desc, eq, gte, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, users } from "@/db/schema";
import {
  AUDIT_PAGE_SIZE,
  type NormalizedAuditFilters,
} from "./filters";

export type AuditRow = {
  id: string;
  ts: Date;
  action: "create" | "update" | "delete";
  entityType: string;
  entityId: string;
  diff: unknown;
  actorId: string;
  actorName: string | null;
  actorEmail: string | null;
};

export type AuditFetchResult = {
  rows: AuditRow[];
  total: number;
  pageSize: number;
};

export async function fetchAuditPage(
  filters: NormalizedAuditFilters,
): Promise<AuditFetchResult> {
  const conditions = [
    gte(auditLog.ts, filters.fromDate),
    lt(auditLog.ts, filters.toDateExclusive),
  ];
  if (filters.actorId) {
    conditions.push(eq(auditLog.actorUserId, filters.actorId));
  }
  if (filters.entityTypes.length > 0) {
    conditions.push(inArray(auditLog.entityType, filters.entityTypes));
  }
  if (filters.actions.length > 0) {
    conditions.push(inArray(auditLog.action, filters.actions));
  }

  const where = and(...conditions);
  const offset = (filters.page - 1) * AUDIT_PAGE_SIZE;

  // Total + page in parallel — separate queries, both indexed by ts.
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: auditLog.id,
        ts: auditLog.ts,
        action: auditLog.action,
        entityType: auditLog.entityType,
        entityId: auditLog.entityId,
        diff: auditLog.diff,
        actorId: auditLog.actorUserId,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(auditLog)
      // leftJoin (not innerJoin): if an actor user row is ever hard-deleted,
      // an innerJoin would silently drop its audit rows from the page while
      // the `total` count below (which has no join) still counts them →
      // phantom pages / vanished entries. leftJoin keeps the rows; the actor
      // renders as actorName ?? actorEmail ?? "—". Both queries apply the
      // SAME `where`, so pagination stays exact.
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(where)
      .orderBy(desc(auditLog.ts))
      .limit(AUDIT_PAGE_SIZE)
      .offset(offset),
    db.select({ value: count() }).from(auditLog).where(where),
  ]);

  return {
    rows,
    total: totalRows[0]?.value ?? 0,
    pageSize: AUDIT_PAGE_SIZE,
  };
}
