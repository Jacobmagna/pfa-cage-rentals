// Append-only audit log helper. Every billing-relevant mutation
// (session create/update/delete, rate-override change, blocked-time
// edit) calls this so disputes have a paper trail.
//
// Atomicity: the caller passes its `db` or transaction handle so the
// audit insert lands in the same batch as the underlying mutation.
// If the mutation rolls back, the audit row rolls back too. Calling
// logAudit standalone with `db` works for fire-and-forget logging
// (e.g. impersonation events, login audit) but mutation paths should
// wrap both in `db.transaction(async (tx) => ...)`.
//
// Diff shape:
//   create: { after: <full new row> }
//   delete: { before: <full old row> }
//   update: { before: <changed keys only>, after: <changed keys only> }
// Keeping updates as changed-keys-only makes grep/audit-page output
// readable; full-row snapshots are reconstructible by walking the
// log if ever needed.
//
// `unknown` ride-along through JSONB: Postgres jsonb accepts anything
// JSON-serializable. We pre-stringify nothing — Drizzle's jsonb column
// handles the wire format. Date values inside `before`/`after` will
// serialize as ISO strings on the way in.

import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import { auditLog } from "@/db/schema";
import * as schema from "@/db/schema";

type Database = NeonHttpDatabase<typeof schema>;

export type LogAuditInput = {
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: "create" | "update" | "delete";
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/**
 * Computes the shallow diff between two snapshots. Returns an object
 * with `before` and `after` each restricted to keys whose values
 * differ (via Object.is — handles NaN, +0/-0 correctly; deep object
 * equality is deliberately not attempted, since changed nested values
 * still register as "this key changed" which is what we want).
 *
 * Exported so tests can hit it directly; also useful if a caller
 * wants to peek at a diff before deciding whether to log.
 */
export function shallowDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const beforeChanged: Record<string, unknown> = {};
  const afterChanged: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.is(before[key], after[key])) {
      beforeChanged[key] = before[key];
      afterChanged[key] = after[key];
    }
  }
  return { before: beforeChanged, after: afterChanged };
}

function buildDiff(input: LogAuditInput): unknown {
  switch (input.action) {
    case "create":
      return { after: input.after ?? null };
    case "delete":
      return { before: input.before ?? null };
    case "update": {
      if (!input.before || !input.after) {
        // An update without both snapshots is almost certainly a caller
        // bug — log what we have and let the dispute investigator see
        // the partial trail rather than silently dropping.
        return { before: input.before ?? null, after: input.after ?? null };
      }
      return shallowDiff(input.before, input.after);
    }
  }
}

/**
 * Inserts an audit row. Pass `db` for standalone logging or the `tx`
 * from `db.transaction(async (tx) => ...)` to keep it atomic with a
 * mutation.
 */
export async function logAudit(
  database: Database,
  input: LogAuditInput,
): Promise<void> {
  await database.insert(auditLog).values({
    actorUserId: input.actorUserId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    diff: buildDiff(input),
  });
}
