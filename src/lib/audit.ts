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

import type { NeonHttpQueryResultHKT } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import { auditLog } from "@/db/schema";
import * as schema from "@/db/schema";

// Accept either the root db handle or the tx parameter from
// db.transaction(async (tx) => ...). Drizzle types them differently
// (`NeonHttpDatabase` vs `PgTransaction<NeonHttpQueryResultHKT, ...>`)
// even though they share the insert/select/update/delete surface we
// care about. Union keeps the call sites clean — callers don't need
// to cast.
type Database =
  | NeonHttpDatabase<typeof schema>
  | PgTransaction<
      NeonHttpQueryResultHKT,
      typeof schema,
      ExtractTablesWithRelations<typeof schema>
    >;

export type LogAuditInput = {
  actorUserId: string;
  entityType: string;
  entityId: string;
  action: "create" | "update" | "delete";
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/**
 * Value-equality check that handles the cases shallowDiff cares about:
 *   - primitives + same-reference objects: Object.is (handles NaN, +0/-0)
 *   - Date instances: compared by .getTime() (two `new Date(x)` are not
 *     reference-equal but should not count as changed when their epoch
 *     matches). This is critical for the audit log: Drizzle returns a
 *     fresh Date instance for every row read, so a row that was just
 *     UPDATEd will hand back distinct Date objects for unchanged
 *     timestamps — without this branch, every Date column shows up in
 *     every update's diff and the audit log becomes noise.
 *
 * Returns true when the two values are equal under the above rules.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) {
    return Object.is(a.getTime(), b.getTime());
  }
  return false;
}

/**
 * Computes the shallow diff between two snapshots. Returns an object
 * with `before` and `after` each restricted to keys whose values
 * differ (via valuesEqual — see above). Deep object equality is
 * deliberately not attempted, since changed nested values still
 * register as "this key changed" which is what we want.
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
    if (!valuesEqual(before[key], after[key])) {
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
      // Most deletes only have a `before` snapshot. But mergeSyntheticCoach
      // (and the soft-delete in user-actions) pass meaningful `after`
      // payloads — the merge target id, sessions-moved count,
      // anonymization shape. Carry them through when present so the
      // audit page can show "deleted X → merged into Y / moved N sessions"
      // instead of just "deleted X".
      return {
        before: input.before ?? null,
        ...(input.after !== undefined &&
          input.after !== null && { after: input.after }),
      };
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
