// Data-Safe Snapshot — the WRITE-ONLY exporter that appends de-identified
// OpFact rows to Magna's central store (a SEPARATE Neon warehouse, NOT in
// this app's Drizzle schema).
//
// WRITE-ONLY CONTRACT (enforced by the store's role grants AND here):
//   - This module issues ONLY a plain `INSERT INTO op_facts (...) VALUES (...)`
//     per fact. It NEVER issues a SELECT, NEVER uses a RETURNING clause, and
//     NEVER uses ON CONFLICT. The pfa_writer role has INSERT only and cannot
//     read any column. Both RETURNING *and* `ON CONFLICT ... DO NOTHING` would
//     fail under that grant:
//       * RETURNING requires SELECT privilege on the returned columns.
//       * ON CONFLICT must READ the table's index to detect the conflict, so
//         PostgreSQL requires SELECT privilege as well ("permission denied for
//         table op_facts" otherwise).
//     A bare single-row INSERT needs only INSERT privilege.
//   - Idempotent: the store's unique index
//     (anon_client_id, metric, period_start, period_end, dims_hash) raises a
//     unique-violation (SQLSTATE 23505) on a duplicate tuple — and raising
//     that violation needs only INSERT privilege. We catch 23505 per fact and
//     treat it as an idempotent no-op (not counted as inserted); any other
//     error is rethrown. dims_hash is computed via the SHARED `dimsHash` so
//     re-runs of the same period collide deterministically.
//   - `inserted` = number of rows ACTUALLY written (each successful single-row
//     INSERT is exactly one row); `attempted` = facts.length. The difference
//     is the dedupe signal. No row is ever read back.
//   - Parameterized values only — fact values/dims are passed as bind params,
//     never string-interpolated into SQL.
//
// The raw `neon()` tagged-template client is used (not Drizzle) because the
// store table is intentionally absent from our schema.

import { neon } from "@neondatabase/serverless";

import { dimsHash } from "./anonymize";
import type { OpFact } from "./types";

export type PushContext = {
  databaseUrl: string;
  anonClientId: string;
  vertical: string;
  periodStart: Date;
  periodEnd: Date;
  sourceRunId: string;
};

export type PushResult = {
  inserted: number;
  attempted: number;
};

// PostgreSQL unique_violation SQLSTATE.
const UNIQUE_VIOLATION = "23505";

/**
 * True iff `err` is a PostgreSQL unique-violation (23505).
 *
 * The `@neondatabase/serverless` HTTP client rejects with a `NeonDbError`
 * (declared in its index.d.ts) that carries the Postgres `code: string |
 * undefined` SQLSTATE. We key off that code. As a belt-and-suspenders
 * fallback (e.g. if a future driver surfaces the error differently), we also
 * sniff the message for the canonical duplicate-key wording — but the code is
 * the authority.
 */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (code === UNIQUE_VIOLATION) {
      return true;
    }
  }
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return (
    message.includes("duplicate key value") ||
    message.includes("unique constraint")
  );
}

/**
 * Append `facts` to the central store's `op_facts` table, idempotently.
 *
 * Each fact issues a plain single-row INSERT (no RETURNING, no ON CONFLICT —
 * both would require SELECT privilege the write-only role lacks). Idempotency
 * comes from the store's unique index
 * (anon_client_id, metric, period_start, period_end, dims_hash): a duplicate
 * tuple raises a unique-violation (23505), which we catch and treat as a
 * no-op. Any other error is rethrown.
 *
 * `inserted` = rows actually written; `attempted` = facts.length. No row is
 * ever read back and no RETURNING clause is used.
 */
export async function pushFacts(
  facts: OpFact[],
  ctx: PushContext,
): Promise<PushResult> {
  if (facts.length === 0) {
    return { inserted: 0, attempted: 0 };
  }

  // Plain neon() client: each query resolves to the rows array (empty for an
  // INSERT with no RETURNING). We never read it — success means the row
  // landed, a 23505 rejection means it was already there.
  const sql = neon(ctx.databaseUrl);

  let inserted = 0;
  for (const fact of facts) {
    const dims = fact.dims ?? null;
    const subType = fact.subType ?? null;
    const dimsHashValue = dimsHash(fact.dims);

    try {
      // Parameterized: every value is a bind param. Plain INSERT — no
      // RETURNING, no ON CONFLICT, no SELECT — so it works under an
      // INSERT-only grant.
      await sql`
        INSERT INTO op_facts (
          anon_client_id,
          vertical,
          sub_type,
          period_start,
          period_end,
          metric,
          value,
          dims,
          dims_hash,
          source_run_id
        ) VALUES (
          ${ctx.anonClientId},
          ${ctx.vertical},
          ${subType},
          ${ctx.periodStart.toISOString()},
          ${ctx.periodEnd.toISOString()},
          ${fact.metric},
          ${fact.value},
          ${dims === null ? null : JSON.stringify(dims)},
          ${dimsHashValue},
          ${ctx.sourceRunId}
        )
      `;
      inserted += 1;
    } catch (err) {
      // Unique-violation = this exact tuple already exists → idempotent no-op.
      // Anything else is a real failure: rethrow.
      if (isUniqueViolation(err)) {
        continue;
      }
      throw err;
    }
  }

  return { inserted, attempted: facts.length };
}
